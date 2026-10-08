import type { Project } from '@universe/db'
import type { ApiHost } from './host'

/**
 * The API over a project file opened directly (the MCP server when the app
 * doesn't have it open, and tests): writes apply at once, tagged as the AI's.
 */
export function projectHost(project: Project): ApiHost {
  return {
    project: () => {
      const { name, rootId } = project.info()
      return { name, rootId, data: project.snapshot() }
    },
    terrainLayers: (worldId) => project.terrain(worldId),
    write: (command) => ({ status: 'applied', target: project.bus.execute(command, 'ai').target })
  }
}
