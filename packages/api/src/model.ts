import {
  DEFAULT_CALENDAR,
  conditionCurves,
  eventDates,
  findBlueprint,
  regionsAt,
  spanDates,
  formatTime,
  parseTime,
  timelineOf,
  type Calendar,
  type ConditionCurve,
  type Exposure,
  type Precision,
  type Region,
  type SpatialNode,
  type Structure,
  type TimelineEvent,
  type StructureWorld,
  type TimelineData,
  type WorldInfo
} from '@universe/core'
import { TerrainModel, generateBase, shapeKey, type BaseTerrain } from '@universe/procgen'
import { exposureAt, systemIdOf, systemModel, worldCalendar, worldClimateOf, type SystemModel, type WorldClimate } from '@universe/sim'
import { ApiError, findOr404, type ApiHost, type ProjectData } from './host'

/** A date as an API client writes it: text in the world's calendar ("1204", "15 Mar 1204", "c. 1200", "4.5 billion years ago"), or a year. */
export type When = string | number

/** A world and what's on it, as of the last read. */
export interface WorldView {
  node: SpatialNode
  info: WorldInfo
  /** Its records only (the project's blueprint and theme libraries too). */
  timeline: TimelineData
  /** Its regions, as drawn (`regionsAt` has them as of a moment). */
  regions: Region[]
}

/** One world's generated terrain with its edit layers, what it was made from, and the weather found on it so far. */
interface Terrain {
  /** Shape, settings and climate: a new model when they change. */
  key: string
  revision: number
  model: TerrainModel
  exposures: Map<string, Exposure>
}

/** Worlds' terrain kept at once (each holds its generated base and edit layers, a few MB). */
const TERRAINS_KEPT = 4

/** The same rows, in the same order: the host keeps unchanged rows between reads. */
const sameRows = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * What the API works out from a project, kept until what it came from
 * changes: star systems, calendars and climates; worlds' terrain (generated
 * once per shape); and structures' condition curves. Reads are cheap because
 * the host shares unchanged parts of the project between reads.
 */
export class ProjectModels {
  /** The project as last read: one read per turn of the event loop, and again after a write. */
  private read: { name: string; rootId: string; data: ProjectData } | undefined
  private systems: { key: readonly unknown[]; byId: Map<string, SystemModel>; calendars: Map<string, Calendar> } | undefined
  /** Worlds' views, by the timeline they were made from (the host keeps it while no record changes), checked against the rest. */
  private worlds = new WeakMap<TimelineData, Map<string, { from: readonly unknown[]; view: WorldView }>>()
  /** Each world's latest view, whose parts a new view reuses where its rows are the same. */
  private lastViews = new Map<string, WorldView>()
  private terrains = new Map<string, Terrain>()
  private bases = new Map<string, Promise<BaseTerrain>>()
  private engines = new Map<string, { key: readonly unknown[]; world: StructureWorld; curves: Map<string, ConditionCurve> }>()

  constructor(private readonly host: ApiHost) {}

  /** The open project's contents; fails when none is open. */
  data(): ProjectData {
    return this.project().data
  }

  /**
   * The open project, read from the host once for everything an answer
   * needs (a list of a thousand dates reads it once, not a thousand times).
   */
  project(): { name: string; rootId: string; data: ProjectData } {
    if (!this.read) {
      const project = this.host.project()
      if (!project) throw new ApiError(409, 'No project is open in Universe')
      this.read = project
      setImmediate(() => (this.read = undefined))
    }
    return this.read
  }

  /** After a write: the next answer reads the project again. */
  forget(): void {
    this.read = undefined
  }

  node(id: string): SpatialNode {
    return findOr404(this.data().nodes, id, 'node')
  }

  /** A world and what's on it, worked out once per read of the project. */
  world(worldId: string): WorldView {
    const data = this.data()
    let views = this.worlds.get(data.timeline)
    if (!views) this.worlds.set(data.timeline, (views = new Map()))
    const from = [data.nodes, data.worlds, data.regions]
    const cached = views.get(worldId)
    if (cached && cached.from.every((k, i) => k === from[i])) return cached.view
    const node = data.nodes.find((n) => n.id === worldId && n.kind === 'world')
    const info = data.worlds.find((w) => w.id === worldId)
    if (!node || !info) throw new ApiError(404, `There is no world ${worldId}`)
    let timeline: TimelineData = { ...timelineOf(data.timeline, worldId), blueprints: data.timeline.blueprints, themes: data.timeline.themes }
    let regions = data.regions.filter((r) => r.worldId === worldId)
    // A change elsewhere in the project leaves this world's view as it was, so what's worked out from it (condition curves) is kept.
    const last = this.lastViews.get(worldId)
    if (last) {
      const keys = Object.keys(timeline) as (keyof TimelineData)[]
      if (keys.every((k) => sameRows(timeline[k], last.timeline[k]))) timeline = last.timeline
      if (sameRows(regions, last.regions)) regions = last.regions
    }
    const view = { node, info, timeline, regions }
    views.set(worldId, { from, view })
    this.lastViews.set(worldId, view)
    return view
  }

  event(id: string): TimelineEvent {
    return findOr404(this.data().timeline.events, id, 'event')
  }

  structure(id: string): Structure {
    return findOr404(this.data().timeline.structures, id, 'structure')
  }

  /** A region of a world, by id. */
  region(worldId: string, id: string): Region {
    return findOr404(this.world(worldId).regions, id, 'region on that world')
  }

  /** A world's regions as they are at `t` (founded, renamed, dissolved). */
  regionsAt(worldId: string, t: number): Region[] {
    const view = this.world(worldId)
    return regionsAt(view.regions, view.timeline.changes, t)
  }

  /** The star system a node is in, as the simulation sees it. */
  system(nodeId: string): SystemModel | undefined {
    const { nodes, worlds, timeline } = this.data()
    this.systemsFor(nodes, worlds, timeline)
    const systemId = systemIdOf(nodes, nodeId)
    if (!systemId) return undefined
    let system = this.systems!.byId.get(systemId)
    if (!system) this.systems!.byId.set(systemId, (system = systemModel(nodes, timeline, systemId, new Map(worlds.map((w) => [w.id, w.settings.radiusKm])))))
    return system
  }

  /** Star systems and calendars as of the project's nodes, worlds, stars and orbits: worked out again when one of them changes. */
  private systemsFor(nodes: SpatialNode[], worlds: WorldInfo[], timeline: TimelineData) {
    const key = [nodes, worlds, timeline.stars, timeline.orbits]
    if (!this.systems || this.systems.key.some((k, i) => k !== key[i])) this.systems = { key, byId: new Map(), calendars: new Map() }
    return this.systems
  }

  /** The calendar a node's dates are written in: a world's own, the Earth calendar elsewhere. Kept until the sky changes. */
  calendar(nodeId: string): Calendar {
    const { nodes, worlds, timeline } = this.data()
    const { calendars } = this.systemsFor(nodes, worlds, timeline)
    let cal = calendars.get(nodeId)
    if (!cal) calendars.set(nodeId, (cal = nodes.find((n) => n.id === nodeId)?.kind === 'world' ? worldCalendar(nodes, this.system(nodeId), nodeId) : DEFAULT_CALENDAR))
    return cal
  }

  climate(worldId: string): WorldClimate | undefined {
    return worldClimateOf(this.data().nodes, this.system(worldId), worldId)
  }

  /** A date a client wrote, as a time on a world's timeline. */
  when(ownerId: string, when: When): number {
    return this.parse(ownerId, when).t
  }

  /** A date a client wrote, or the timeline's "now" if they wrote none. */
  whenOrNow(ownerId: string, when: When | undefined): number {
    return when === undefined ? this.now(ownerId) : this.when(ownerId, when)
  }

  /** A date a client wrote, with how precisely they wrote it ("1204" is a year, "15 Mar 1204" a day). */
  parse(ownerId: string, when: When): { t: number; precision: Precision } {
    const parsed = parseTime(typeof when === 'number' ? String(when) : when, this.calendar(ownerId))
    if (!parsed) throw new ApiError(400, `“${when}” is not a date. Try 1204, 15 Mar 1204, c. 1200 or 4.5 billion years ago`)
    return parsed
  }

  /** A time on a world's timeline, written the way the app shows it. */
  date(ownerId: string, t: number, precision: Precision = 'day'): string {
    return formatTime(t, precision, this.calendar(ownerId))
  }

  /** "1204 – 1210" in a world's calendar. */
  spanDates(ownerId: string, span: { start: number; end: number }): string {
    return spanDates(span, this.calendar(ownerId))
  }

  /** An event's dates at its precision, in its world's calendar. */
  eventDates(e: TimelineEvent): string {
    return eventDates(e, this.calendar(e.ownerId))
  }

  /** The timeline's "now" on a world: where its playhead starts. */
  now(ownerId: string): number {
    return this.data().timeline.timelines.find((t) => t.id === ownerId)?.now ?? 0
  }

  /** A world's terrain as it is now: generated once per shape, its edit layers read again only when they change. */
  private async terrain(worldId: string): Promise<Terrain> {
    const { node, info } = this.world(worldId)
    const climate = this.climate(worldId)
    const shape = shapeKey(node.seed, info.settings.terrain)
    const key = `${shape}|${JSON.stringify(info.settings)}|${JSON.stringify(climate ?? null)}`
    const cached = this.terrains.get(worldId)
    if (cached?.key === key) {
      if (cached.revision !== info.terrainRevision) {
        cached.model.setLayers(this.host.terrainLayers(worldId))
        cached.revision = info.terrainRevision
        cached.exposures.clear()
      }
      return cached
    }
    const base = await this.base(node.seed, info.settings.terrain, shape)
    const model = new TerrainModel(info.settings, base, this.host.terrainLayers(worldId))
    model.setSky(climate)
    const terrain = { key, revision: info.terrainRevision, model, exposures: new Map<string, Exposure>() }
    this.terrains.delete(worldId)
    this.terrains.set(worldId, terrain)
    if (this.terrains.size > TERRAINS_KEPT) this.terrains.delete(this.terrains.keys().next().value!)
    return terrain
  }

  private base(seed: number, params: WorldInfo['settings']['terrain'], key: string): Promise<BaseTerrain> {
    let base = this.bases.get(key)
    if (!base) {
      base = this.host.baseTerrain ? this.host.baseTerrain(seed, params) : Promise.resolve(generateBase(seed, params))
      this.bases.set(key, base)
      // A few shapes are kept: switching between worlds doesn't regenerate.
      if (this.bases.size > 4) this.bases.delete(this.bases.keys().next().value!)
      base.catch(() => this.bases.get(key) === base && this.bases.delete(key))
    }
    return base
  }

  /** Every structure's condition curve on a world, with the weather where each stands (as the app works them out). */
  async structures(worldId: string): Promise<{ world: StructureWorld; curves: Map<string, ConditionCurve> }> {
    const view = this.world(worldId)
    const terrain = view.timeline.structures.length ? await this.terrain(worldId) : undefined
    const key = [view.timeline, view.regions, view.info.settings, terrain?.model, terrain?.revision]
    const cached = this.engines.get(worldId)
    if (cached && cached.key.every((k, i) => k === key[i])) return cached
    const climate = this.climate(worldId)
    const world: StructureWorld = {
      data: view.timeline,
      regions: view.regions,
      radiusKm: view.info.settings.radiusKm,
      erosionSpeed: view.info.settings.erosionSpeed,
      blueprint: (id) => findBlueprint(view.timeline.blueprints, id),
      exposure: terrain
        ? (s: Structure) => {
            const at = `${s.lat}:${s.lon}`
            let e = terrain.exposures.get(at)
            if (!e) terrain.exposures.set(at, (e = exposureAt(terrain.model, climate, s.lat, s.lon)))
            return e
          }
        : undefined
    }
    const engine = { key, world, curves: conditionCurves(world) }
    this.engines.set(worldId, engine)
    return engine
  }
}
