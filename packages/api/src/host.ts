import type { Command, Region, SpatialNode, Target, TerrainLayers, TimelineData, TerrainParams, WorldInfo } from '@universe/core'
import type { BaseTerrain } from '@universe/procgen'

/** Everything live in a project, as the app and the API see it (unchanged parts are shared between reads). */
export interface ProjectData {
  nodes: SpatialNode[]
  worlds: WorldInfo[]
  regions: Region[]
  timeline: TimelineData
}

/** A write from an API client: applied, or (in review mode) waiting for the user. */
export type WriteOutcome = { status: 'applied'; target?: Target } | { status: 'proposed'; proposalId: string }

/**
 * What the API runs against: the open project in the app (where writes show
 * at once and can be reviewed and undone), or a project file opened directly
 * by the MCP server when the app doesn't have it open.
 */
export interface ApiHost {
  /** The open project, or undefined with none open. */
  project(): { name: string; rootId: string; data: ProjectData } | undefined
  /** A world's edit layers, with the revision they're at. */
  terrainLayers(worldId: string): TerrainLayers & { revision: number }
  /** Applies one command from an API client (tagged as the AI's), or proposes it in review mode. `summary` says what it does, for people. */
  write(command: Command, summary: string): WriteOutcome
  /** A world's generated terrain, worked out off the main thread where the host can; generated in place otherwise. */
  baseTerrain?(seed: number, params: TerrainParams): Promise<BaseTerrain>
}

/** An answer the API can't give, with the HTTP status that says why. */
export class ApiError extends Error {
  override name = 'ApiError'
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export const notFound = (what: string, id: string) => new ApiError(404, `There is no ${what} ${id}`)
