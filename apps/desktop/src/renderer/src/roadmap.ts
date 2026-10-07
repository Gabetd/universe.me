/** Shown on the welcome screen so each build says how far along it is. Keep in sync with PLAN.md §9. */
export type MilestoneStatus = 'done' | 'active' | 'planned'

export interface Milestone {
  id: string
  title: string
  status: MilestoneStatus
  summary: string
}

export const ROADMAP: Milestone[] = [
  { id: 'M0', title: 'Foundations', status: 'active', summary: 'App shell, .universe project files, undo/redo, the universe tree' },
  { id: 'M1', title: 'Worlds & globe', status: 'planned', summary: 'Generated terrain, globe + map views, sculpting, biomes, regions' },
  { id: 'M2', title: 'Timeline', status: 'planned', summary: 'Events, causal links, groups, locations, time-aware view' },
  { id: 'M3', title: 'Structures', status: 'planned', summary: 'Blueprints, placement, notes, event effects, maintained/weathered' },
  { id: 'M4', title: 'Star systems & sim', status: 'planned', summary: 'Orbits, calendars, moon phases, climate, erosion' },
  { id: 'M5', title: 'Scale navigation', status: 'planned', summary: 'Galaxies, clusters, seamless zoom between levels' },
  { id: 'M6', title: 'Themes', status: 'planned', summary: 'Themes per world and time span, blending on the timeline' },
  { id: 'M7', title: 'API & MCP', status: 'planned', summary: 'Local REST API and MCP server for Claude Code' },
  { id: 'M8', title: 'Polish & release', status: 'planned', summary: 'Onboarding, performance, signed installers, auto-update' }
]
