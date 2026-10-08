import {
  DEFAULT_CALENDAR,
  conditionCurves,
  findBlueprint,
  formatTime,
  parseTime,
  timelineOf,
  type Calendar,
  type ConditionCurve,
  type Exposure,
  type Precision,
  type SpatialNode,
  type Structure,
  type StructureWorld,
  type TimelineData,
  type WorldInfo
} from '@universe/core'
import { TerrainModel, generateBase, shapeKey, type BaseTerrain } from '@universe/procgen'
import { exposureAt, systemIdOf, systemModel, worldCalendar, worldClimateOf, type SystemModel, type WorldClimate } from '@universe/sim'
import { ApiError, notFound, type ApiHost, type ProjectData } from './host'

/** A date as an API client writes it: text in the world's calendar ("1204", "15 Mar 1204", "c. 1200", "4.5 billion years ago"), or a year. */
export type When = string | number

/** A world and what's on it, as of the last read. */
export interface WorldView {
  node: SpatialNode
  info: WorldInfo
  /** Its records only (the project's blueprint and theme libraries too). */
  timeline: TimelineData
}

/** One world's generated terrain with its edit layers, and what it was made from. */
interface Terrain {
  key: string
  model: TerrainModel
}

/**
 * What the API works out from a project, kept until what it came from
 * changes: star systems, calendars and climates; worlds' terrain (generated
 * once per shape); and structures' condition curves. Reads are cheap because
 * the host shares unchanged parts of the project between reads.
 */
export class ProjectModels {
  private systems: { key: readonly unknown[]; byId: Map<string, SystemModel> } | undefined
  private worlds = new WeakMap<TimelineData, Map<string, TimelineData>>()
  private terrains = new Map<string, Terrain>()
  private bases = new Map<string, Promise<BaseTerrain>>()
  private engines = new Map<string, { key: readonly unknown[]; world: StructureWorld; curves: Map<string, ConditionCurve> }>()

  constructor(private readonly host: ApiHost) {}

  /** The open project's contents; fails when none is open. */
  data(): ProjectData {
    const project = this.host.project()
    if (!project) throw new ApiError(409, 'No project is open in Universe')
    return project.data
  }

  project(): { name: string; rootId: string; data: ProjectData } {
    const project = this.host.project()
    if (!project) throw new ApiError(409, 'No project is open in Universe')
    return project
  }

  node(id: string): SpatialNode {
    const node = this.data().nodes.find((n) => n.id === id)
    if (!node) throw notFound('node', id)
    return node
  }

  world(worldId: string): WorldView {
    const data = this.data()
    const node = data.nodes.find((n) => n.id === worldId)
    const info = data.worlds.find((w) => w.id === worldId)
    if (!node || node.kind !== 'world' || !info) throw notFound('world', worldId)
    let own = this.worlds.get(data.timeline)
    if (!own) this.worlds.set(data.timeline, (own = new Map()))
    let timeline = own.get(worldId)
    if (!timeline) own.set(worldId, (timeline = { ...timelineOf(data.timeline, worldId), blueprints: data.timeline.blueprints, themes: data.timeline.themes }))
    return { node, info, timeline }
  }

  /** The star system a node is in, as the simulation sees it. */
  system(nodeId: string): SystemModel | undefined {
    const { nodes, worlds, timeline } = this.data()
    const key = [nodes, worlds, timeline.stars, timeline.orbits]
    if (!this.systems || this.systems.key.some((k, i) => k !== key[i])) this.systems = { key, byId: new Map() }
    const systemId = systemIdOf(nodes, nodeId)
    if (!systemId) return undefined
    let system = this.systems.byId.get(systemId)
    if (!system) this.systems.byId.set(systemId, (system = systemModel(nodes, timeline, systemId, new Map(worlds.map((w) => [w.id, w.settings.radiusKm])))))
    return system
  }

  /** The calendar a node's dates are written in: a world's own, the Earth calendar elsewhere. */
  calendar(nodeId: string): Calendar {
    const nodes = this.data().nodes
    return nodes.find((n) => n.id === nodeId)?.kind === 'world' ? worldCalendar(nodes, this.system(nodeId), nodeId) : DEFAULT_CALENDAR
  }

  climate(worldId: string): WorldClimate | undefined {
    return worldClimateOf(this.data().nodes, this.system(worldId), worldId)
  }

  /** A date a client wrote, as a time on a world's timeline. */
  when(ownerId: string, when: When): number {
    return this.parse(ownerId, when).t
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

  /** The timeline's "now" on a world: where its playhead starts. */
  now(ownerId: string): number {
    return this.data().timeline.timelines.find((t) => t.id === ownerId)?.now ?? 0
  }

  /** A world's terrain as it is now: generated once per shape, its edit layers reloaded when they change. */
  async terrain(worldId: string): Promise<TerrainModel> {
    const { node, info } = this.world(worldId)
    const climate = this.climate(worldId)
    const layers = this.host.terrainLayers(worldId)
    const shape = shapeKey(node.seed, info.settings.terrain)
    const key = `${shape}|${layers.revision}|${JSON.stringify(info.settings)}|${JSON.stringify(climate ?? null)}`
    const cached = this.terrains.get(worldId)
    if (cached?.key === key) return cached.model
    const model = new TerrainModel(info.settings, await this.base(node.seed, info.settings.terrain, shape), layers)
    model.setSky(climate)
    this.terrains.set(worldId, { key, model })
    return model
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
    const data = this.data()
    const model = view.timeline.structures.length ? await this.terrain(worldId) : undefined
    const key = [view.timeline, data.regions, view.info, model]
    const cached = this.engines.get(worldId)
    if (cached && cached.key.every((k, i) => k === key[i])) return cached
    const climate = this.climate(worldId)
    const exposures = new Map<string, Exposure>()
    const world: StructureWorld = {
      data: view.timeline,
      regions: data.regions.filter((r) => r.worldId === worldId),
      radiusKm: view.info.settings.radiusKm,
      erosionSpeed: view.info.settings.erosionSpeed,
      blueprint: (id) => findBlueprint(data.timeline.blueprints, id),
      exposure: model
        ? (s: Structure) => {
            const at = `${s.lat}:${s.lon}`
            let e = exposures.get(at)
            if (!e) exposures.set(at, (e = exposureAt(model, climate, s.lat, s.lon)))
            return e
          }
        : undefined
    }
    const engine = { key, world, curves: conditionCurves(world) }
    this.engines.set(worldId, engine)
    return engine
  }
}
