import type { Project } from '@universe/db'
import { ApiError, type ApiHost } from './host'

/**
 * The API over a project file opened directly (the stdio MCP server when the
 * app doesn't have it open, and tests): writes apply at once, tagged as the
 * AI's. `project` gives the open file, which may come and go.
 */
export function projectHost(project: Project | (() => Project | undefined), missing = 'No project is open'): ApiHost {
  const open = typeof project === 'function' ? project : () => project
  const require = () => {
    const p = open()
    if (!p) throw new ApiError(409, missing)
    return p
  }
  return {
    project: () => {
      const p = open()
      if (!p) return undefined
      const { name, rootId } = p.info()
      return { name, rootId, data: p.snapshot() }
    },
    terrainLayers: (worldId) => require().terrain(worldId),
    write: (command) => ({ status: 'applied', target: require().bus.execute(command, 'ai').target })
  }
}
