import { insidePolygon, greatCircleKm } from './geo'
import type { TimelineData } from './records'
import { MATERIAL_INFO, stageOf, type Blueprint, type EventEffect, type Material, type Stage, type Structure } from './structures'
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

/** A structure's state just after a step. */
interface State {
  at: Time
  exists: boolean
  condition: number
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
}

export interface ConditionCurve {
  structureId: string
  steps: Step[]
  states: State[]
  /** Decay per year while weathered, already including the erosion speed (0 = never decays). */
  decayPerYear: number
}

/**
 * Decay per year of a blueprint (ln 2 / half-life). Its half-life is its
 * parts' half-lives averaged by volume, so a stone keep with a wooden roof
 * lasts nearly as long as stone. (Per-part decay, where the roof goes first,
 * comes with M4.) Magic parts count as lasting a billion years.
 */
export function decayRate(blueprint: Blueprint | undefined): number {
  const halfLife = (m: Material) => Math.min(MATERIAL_INFO[m].halfLifeYears, 1e9)
  if (!blueprint) return Math.LN2 / halfLife('stone')
  if (blueprint.model) return blueprint.model.material === 'magic' ? 0 : Math.LN2 / halfLife(blueprint.model.material)
  let total = 0
  let weighted = 0
  for (const p of blueprint.parts) {
    const volume = p.size[0] * p.size[1] * p.size[2]
    total += volume
    weighted += volume * halfLife(p.material)
  }
  if (!total || blueprint.parts.every((p) => p.material === 'magic')) return 0
  return Math.LN2 / (weighted / total)
}

export const materialsOf = (b: Blueprint | undefined): Material[] => (b ? (b.model ? [b.model.material] : [...new Set(b.parts.map((p) => p.material))]) : [])

/** Condition after `dt` seconds of being (not) maintained. */
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
  const rate = structure.neverDecays ? 0 : decayRate(world.blueprint(structure.blueprintId)) * world.erosionSpeed
  const states: State[] = []
  let s: State = { at: -Infinity, exists: false, condition: 0, maintained: structure.maintained, name: structure.name, blueprintId: structure.blueprintId }
  let built = false
  for (const step of steps) {
    const condition = s.exists ? evolve(s.condition, step.at - s.at, s.maintained, rate) : 0
    s = { ...s, at: step.at, condition, exists: s.exists && condition > 0 }
    switch (step.kind) {
      case 'build':
        // A later build of a standing structure is a rebuild; the first one also starts its maintenance.
        s = { ...s, exists: true, condition: 100, maintained: built ? s.maintained : structure.maintained }
        built = true
        break
      case 'damage':
        if (s.exists) s.condition = Math.max(0, s.condition - step.amount!)
        break
      case 'destroy':
        s.condition = 0
        break
      case 'repair':
        if (s.exists) s.condition = Math.min(100, s.condition + step.amount!)
        break
      case 'maintenance':
        s.maintained = step.maintained!
        break
      case 'modify':
        if (step.rename) s.name = step.rename
        if (step.blueprintId) s.blueprintId = step.blueprintId
        break
    }
    s.exists = s.exists && s.condition > 0
    states.push({ ...s })
  }
  return { structureId: structure.id, steps, states, decayPerYear: rate }
}

/** A structure as of `t`. Before it's built, or once destroyed or eroded away, `exists` is false. */
export function stateAt(curve: ConditionCurve, t: Time): StructureState {
  let last: State | undefined
  for (const s of curve.states) {
    if (s.at > t) break
    last = s
  }
  if (!last) {
    const first = curve.states[0]
    return { exists: false, condition: 0, stage: 'destroyed', maintained: first?.maintained ?? false, name: first?.name ?? '', blueprintId: first?.blueprintId ?? '' }
  }
  const condition = last.exists ? evolve(last.condition, t - last.at, last.maintained, curve.decayPerYear) : 0
  return { exists: condition > 0, condition, stage: stageOf(condition), maintained: last.maintained, name: last.name, blueprintId: last.blueprintId }
}

/** When a weathering structure, left alone after `t`, will have eroded away. Undefined if it won't. */
export function erodesAt(curve: ConditionCurve, t: Time): Time | undefined {
  const s = stateAt(curve, t)
  if (!s.exists || s.maintained || !curve.decayPerYear) return undefined
  return t + (Math.log((s.condition + FLOOR) / FLOOR) / curve.decayPerYear) * YEAR
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
