import { insidePolygon, greatCircleKm } from './geo'
import type { TimelineData } from './records'
import { MATERIAL_INFO, stageOf, weatherFactor, type Blueprint, type EventEffect, type Exposure, type Material, type Stage, type Structure } from './structures'
import { DEFAULT_CALENDAR, secondsPerYear, type Time } from './time'
import { eventPlace, regionAt, type Warning } from './timeline-queries'
import type { Region } from './world'

/**
 * Structure condition over time (PLAN.md §4.7). Nothing here is stored: a
 * structure's history is a list of steps (built, damaged, maintenance turned
 * off…), and between steps condition follows a closed-form curve, so asking
 * for any moment is a lookup, not a simulation.
 */

const YEAR = secondsPerYear(DEFAULT_CALENDAR)
/** Maintained structures get back to near-pristine over a few decades after damage. */
const RECOVERY_YEARS = 12
/** Weathering heads for −FLOOR rather than 0, so it reaches 0 (eroded away) in finite time. */
const FLOOR = 5

/** What the condition engine needs to know about a world. */
export interface StructureWorld {
  data: Pick<TimelineData, 'events' | 'effects' | 'maintenances' | 'structures' | 'blueprints' | 'changes'>
  regions: Region[]
  radiusKm: number
  /** Multiplies every material's decay rate (1 = the defaults). */
  erosionSpeed: number
  blueprint(id: string): Blueprint | undefined
  /** The weather where a structure stands; without it, every place is temperate. */
  exposure?(structure: Structure): Exposure | undefined
}

export type StepKind = 'build' | 'damage' | 'destroy' | 'repair' | 'maintenance' | 'modify'

/** Something that happens to one structure at one moment. */
export interface Step {
  at: Time
  kind: StepKind
  /** damage/repair: condition points, already scaled by falloff. */
  amount?: number
  maintained?: boolean
  rename?: string
  blueprintId?: string
  /** What caused it, so the UI can say why. */
  eventId?: string
  effectId?: string
}

/**
 * One material of a structure: its share of the volume and how fast it
 * decays per year while weathered, with the local weather and the world's
 * erosion speed already in (0 = never).
 */
export interface MaterialShare {
  material: Material
  weight: number
  decayPerYear: number
}

/** A structure's state just after a step. Each material has its own condition; overall condition is their average by volume. */
interface State {
  at: Time
  exists: boolean
  /** Condition of each of the blueprint's materials, in `shares` order. */
  parts: number[]
  maintained: boolean
  name: string
  blueprintId: string
}

export interface StructureState {
  exists: boolean
  condition: number
  stage: Stage
  maintained: boolean
  name: string
  blueprintId: string
  /** Condition of each material it's made of: the wooden roof goes long before the stone walls. */
  materials: Partial<Record<Material, number>>
}

export interface ConditionCurve {
  structureId: string
  steps: Step[]
  states: State[]
  /** The materials of each blueprint the structure has had (a `modify` can swap it). */
  shares: Map<string, MaterialShare[]>
}

/**
 * The materials of a blueprint by share of its volume, each with its decay
 * rate (ln 2 / half-life) sped up or slowed down by the weather where it
 * stands. Magic never decays.
 */
export function materialShares(blueprint: Blueprint | undefined, exposure: Exposure | undefined, erosionSpeed: number, neverDecays = false): MaterialShare[] {
  const volumes = new Map<Material, number>()
  if (!blueprint) volumes.set('stone', 1)
  else if (blueprint.model) volumes.set(blueprint.model.material, 1)
  else for (const p of blueprint.parts) volumes.set(p.material, (volumes.get(p.material) ?? 0) + p.size[0] * p.size[1] * p.size[2])
  const total = [...volumes.values()].reduce((a, b) => a + b, 0) || 1
  return [...volumes].map(([material, volume]) => {
    const halfLife = MATERIAL_INFO[material].halfLifeYears
    const decayPerYear = neverDecays || !Number.isFinite(halfLife) ? 0 : (Math.LN2 / halfLife) * weatherFactor(material, exposure) * erosionSpeed
    return { material, weight: volume / total, decayPerYear }
  })
}

const overall = (parts: number[], shares: MaterialShare[]) => Math.min(100, parts.reduce((n, c, i) => n + c * shares[i]!.weight, 0))

export const materialsOf = (b: Blueprint | undefined): Material[] => (b ? (b.model ? [b.model.material] : [...new Set(b.parts.map((p) => p.material))]) : [])

/** One material's condition after `dt` seconds of being (not) maintained. */
function evolve(condition: number, dt: number, maintained: boolean, decayPerYear: number): number {
  if (condition <= 0 || dt <= 0) return condition
  const years = dt / YEAR
  if (maintained) return 100 - (100 - condition) * Math.exp(-years / RECOVERY_YEARS)
  if (!decayPerYear) return condition
  return Math.max(0, (condition + FLOOR) * Math.exp(-decayPerYear * years) - FLOOR)
}

/** Which structures an effect reaches, and how strongly (1 at full strength, less with falloff). */
export function effectHits(effect: EventEffect, world: StructureWorld): { structureId: string; strength: number }[] {
  const event = world.data.events.find((e) => e.id === effect.eventId)
  if (!event) return []
  const onWorld = world.data.structures.filter((s) => s.ownerId === effect.ownerId)
  const { tags, materials } = effect.filter
  const passes = (s: Structure) =>
    (!tags.length || s.tags.some((t) => tags.includes(t))) && (!materials.length || materialsOf(world.blueprint(s.blueprintId)).some((m) => materials.includes(m)))
  const t = effect.target
  if (t.kind === 'structures') return onWorld.filter((s) => t.ids.includes(s.id) && passes(s)).map((s) => ({ structureId: s.id, strength: 1 }))
  if (t.kind === 'region') {
    const region = world.regions.find((r) => r.id === t.regionId)
    if (!region || !regionAt(region, world.data.changes, event.start)) return []
    return onWorld.filter((s) => passes(s) && insidePolygon(s, region.points)).map((s) => ({ structureId: s.id, strength: 1 }))
  }
  const center = eventPlace(event, world.regions)
  if (!center) return []
  return onWorld.flatMap((s) => {
    const d = greatCircleKm(center, s, world.radiusKm)
    if (d > t.km || !passes(s)) return []
    return [{ structureId: s.id, strength: t.falloff ? 1 - d / t.km : 1 }]
  })
}

const KIND_ORDER: Record<StepKind, number> = { build: 0, modify: 1, maintenance: 2, damage: 3, destroy: 4, repair: 5 }

/** Every structure's steps on a world, from its build date, its maintenance changes and event effects. */
export function structureSteps(world: StructureWorld): Map<string, Step[]> {
  const steps = new Map<string, Step[]>(world.data.structures.map((s) => [s.id, [{ at: s.builtAt, kind: 'build' }]]))
  for (const m of world.data.maintenances) steps.get(m.structureId)?.push({ at: m.at, kind: 'maintenance', maintained: m.maintained, eventId: m.causeEventId ?? undefined })
  const eventStart = new Map(world.data.events.map((e) => [e.id, e.start]))
  for (const effect of world.data.effects) {
    const at = eventStart.get(effect.eventId)
    if (at === undefined) continue
    for (const { structureId, strength } of effectHits(effect, world)) {
      const base = { at, eventId: effect.eventId, effectId: effect.id }
      const step: Step =
        effect.type === 'damage' ? { ...base, kind: 'damage', amount: effect.amount * strength }
        : effect.type === 'repair' ? { ...base, kind: 'repair', amount: effect.amount * strength }
        : effect.type === 'set_maintenance' ? { ...base, kind: 'maintenance', maintained: effect.maintained }
        : effect.type === 'modify' ? { ...base, kind: 'modify', rename: effect.rename ?? undefined, blueprintId: effect.blueprintId ?? undefined }
        : { ...base, kind: effect.type }
      steps.get(structureId)?.push(step)
    }
  }
  for (const list of steps.values()) list.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
  return steps
}

/** Plays a structure's steps in order, keeping its state after each. */
export function conditionCurve(structure: Structure, steps: Step[], world: StructureWorld): ConditionCurve {
  const exposure = world.exposure?.(structure)
  const shares = new Map<string, MaterialShare[]>()
  const sharesOf = (blueprintId: string) => {
    let list = shares.get(blueprintId)
    if (!list) shares.set(blueprintId, (list = materialShares(world.blueprint(blueprintId), exposure, world.erosionSpeed, structure.neverDecays)))
    return list
  }
  const states: State[] = []
  let s: State = { at: -Infinity, exists: false, parts: sharesOf(structure.blueprintId).map(() => 0), maintained: structure.maintained, name: structure.name, blueprintId: structure.blueprintId }
  let built = false
  const all = (f: (c: number) => number) => (s.parts = s.parts.map(f))
  for (const step of steps) {
    const list = sharesOf(s.blueprintId)
    const parts = s.exists ? s.parts.map((c, i) => evolve(c, step.at - s.at, s.maintained, list[i]!.decayPerYear)) : s.parts.map(() => 0)
    s = { ...s, at: step.at, parts, exists: s.exists && overall(parts, list) > 0 }
    switch (step.kind) {
      case 'build':
        // A later build of a standing structure is a rebuild; the first one also starts its maintenance.
        s = { ...s, exists: true, parts: s.parts.map(() => 100), maintained: built ? s.maintained : structure.maintained }
        built = true
        break
      case 'damage':
        if (s.exists) all((c) => Math.max(0, c - step.amount!))
        break
      case 'destroy':
        all(() => 0)
        break
      case 'repair':
        if (s.exists) all((c) => Math.min(100, c + step.amount!))
        break
      case 'maintenance':
        s.maintained = step.maintained!
        break
      case 'modify':
        if (step.rename) s.name = step.rename
        if (step.blueprintId && step.blueprintId !== s.blueprintId) {
          // A new blueprint (an expansion, a conversion) starts at the condition the old one had.
          const was = overall(s.parts, list)
          s.blueprintId = step.blueprintId
          s.parts = sharesOf(s.blueprintId).map(() => was)
        }
        break
    }
    s.exists = s.exists && overall(s.parts, sharesOf(s.blueprintId)) > 0
    states.push({ ...s, parts: [...s.parts] })
  }
  return { structureId: structure.id, steps, states, shares }
}

/** The state at `t` that follows from the last step before it. */
function lastState(curve: ConditionCurve, t: Time): State | undefined {
  let last: State | undefined
  for (const s of curve.states) {
    if (s.at > t) break
    last = s
  }
  return last
}

/** Each material's condition `t` seconds after a state, and overall. */
function partsAt(curve: ConditionCurve, s: State, t: Time): { parts: number[]; condition: number } {
  const list = curve.shares.get(s.blueprintId)!
  const parts = s.exists ? s.parts.map((c, i) => evolve(c, t - s.at, s.maintained, list[i]!.decayPerYear)) : s.parts.map(() => 0)
  return { parts, condition: overall(parts, list) }
}

/** A structure as of `t`. Before it's built, or once destroyed or eroded away, `exists` is false. */
export function stateAt(curve: ConditionCurve, t: Time): StructureState {
  const last = lastState(curve, t)
  if (!last) {
    const first = curve.states[0]
    return { exists: false, condition: 0, stage: 'destroyed', maintained: first?.maintained ?? false, name: first?.name ?? '', blueprintId: first?.blueprintId ?? '', materials: {} }
  }
  const { parts, condition } = partsAt(curve, last, t)
  const list = curve.shares.get(last.blueprintId)!
  const materials = Object.fromEntries(list.map((m, i) => [m.material, parts[i]!]))
  return { exists: condition > 0, condition, stage: stageOf(condition), maintained: last.maintained, name: last.name, blueprintId: last.blueprintId, materials }
}

/** When a weathering structure, left alone after `t`, will have eroded away: when its last material goes. Undefined if it won't. */
export function erodesAt(curve: ConditionCurve, t: Time): Time | undefined {
  const last = lastState(curve, t)
  if (!last?.exists || last.maintained) return undefined
  const list = curve.shares.get(last.blueprintId)!
  const { parts, condition } = partsAt(curve, last, t)
  if (condition <= 0) return undefined
  let latest = t
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]! <= 0) continue
    const rate = list[i]!.decayPerYear
    if (!rate) return undefined
    latest = Math.max(latest, t + (Math.log((parts[i]! + FLOOR) / FLOOR) / rate) * YEAR)
  }
  return latest
}

/** When a weathering structure, left alone after `t`, falls into ruin (condition under 20). Undefined if it won't, or already has. */
export function ruinAt(curve: ConditionCurve, t: Time): Time | undefined {
  const end = erodesAt(curve, t)
  const last = lastState(curve, t)
  if (end === undefined || !last || partsAt(curve, last, t).condition < RUIN) return undefined
  // Condition only falls while weathered, so bisect for the crossing.
  let lo = t
  let hi = end
  for (let k = 0; k < 60 && hi - lo > 3600; k++) {
    const mid = (lo + hi) / 2
    if (partsAt(curve, last, mid).condition >= RUIN) lo = mid
    else hi = mid
  }
  return hi
}

/** Where condition ruin starts (the Ruin stage). */
const RUIN = 20

/** A moment the condition engine works out by itself: a structure falling into ruin, or eroding away, while left to weather. */
export interface DerivedEvent {
  structureId: string
  kind: 'ruin' | 'eroded'
  at: Time
}

/**
 * The moments weathering brings structures to ruin or erodes them away
 * (PLAN.md §4.7: derived timeline events), only within stretches where
 * nothing else happens to them: a later step (a repair, being maintained
 * again) can stop it.
 */
export function derivedEvents(curves: Map<string, ConditionCurve>): DerivedEvent[] {
  const out: DerivedEvent[] = []
  for (const curve of curves.values()) {
    curve.states.forEach((s, i) => {
      if (!s.exists || s.maintained) return
      const until = curve.states[i + 1]?.at ?? Infinity
      const ruin = ruinAt(curve, s.at)
      if (ruin !== undefined && ruin < until) out.push({ structureId: curve.structureId, kind: 'ruin', at: ruin })
      const gone = erodesAt(curve, s.at)
      if (gone !== undefined && gone < until) out.push({ structureId: curve.structureId, kind: 'eroded', at: gone })
    })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Condition curves for every structure on a world. */
export function conditionCurves(world: StructureWorld): Map<string, ConditionCurve> {
  const steps = structureSteps(world)
  return new Map(world.data.structures.map((s) => [s.id, conditionCurve(s, steps.get(s.id) ?? [], world)]))
}

/**
 * Structure mistakes worth a warning (PLAN.md §4.7): effects that reach
 * nothing, repairs of something already gone, and maintenance changes before
 * the structure was built.
 */
export function structureWarnings(world: StructureWorld, curves: Map<string, ConditionCurve>): Warning[] {
  const warnings: Warning[] = []
  const events = new Map(world.data.events.map((e) => [e.id, e]))
  const structures = new Map(world.data.structures.map((s) => [s.id, s]))
  for (const effect of world.data.effects) {
    const event = events.get(effect.eventId)
    if (!event) continue
    const hits = effectHits(effect, world)
    const where = effect.target.kind === 'radius' && !eventPlace(event, world.regions) ? ' (the event has no place yet)' : ''
    if (!hits.length) warnings.push({ message: `“${event.title}” ${effect.type.replace('_', ' ')} effect reaches no structures${where}`, refs: [{ kind: 'event', id: event.id }] })
    if (effect.type !== 'repair') continue
    for (const { structureId } of hits) {
      const curve = curves.get(structureId)
      if (curve && !stateAt(curve, event.start - 1).exists) {
        warnings.push({ message: `“${event.title}” repairs ${structures.get(structureId)?.name}, which is already gone then. Rebuild it instead?`, refs: [{ kind: 'event', id: event.id }, { kind: 'structure', id: structureId }] })
      }
    }
  }
  for (const m of world.data.maintenances) {
    const s = structures.get(m.structureId)
    if (s && m.at < s.builtAt) warnings.push({ message: `${s.name}'s maintenance changes before it is built`, refs: [{ kind: 'structure', id: s.id }] })
  }
  return warnings
}
