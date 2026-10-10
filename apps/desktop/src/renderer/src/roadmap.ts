/** Shown on the welcome screen so each build says how far along it is. Keep in sync with PLAN.md §9. */
export type MilestoneStatus = 'done' | 'active' | 'planned'

export interface Milestone {
  id: string
  title: string
  status: MilestoneStatus
  summary: string
}

export const ROADMAP: Milestone[] = [
  { id: 'M0', title: 'Foundations', status: 'done', summary: 'App shell, .universe project files, undo/redo, the universe tree' },
  { id: 'M1', title: 'Worlds & globe', status: 'done', summary: 'Generated terrain, globe + map views, sculpting, biomes, regions' },
  { id: 'M2', title: 'Timeline', status: 'done', summary: 'Events, causal links, groups, locations, time-aware view, world canvas' },
  { id: 'M3', title: 'Structures', status: 'done', summary: 'Blueprints, placement, event effects, weathering; ground view up close; characters' },
  { id: 'M4', title: 'Star systems & sim', status: 'done', summary: 'Orbits, calendars, moon phases and eclipses, climate, species, erosion' },
  { id: 'M5', title: 'Scale navigation', status: 'done', summary: 'Seeded universe, clusters, galaxies and planets; one zoom through them; claim anything' },
  { id: 'M6', title: 'Themes', status: 'done', summary: 'A theme library, theme spans on the timeline per world or region, views that blend as the playhead moves' },
  { id: 'M7', title: 'API & MCP', status: 'done', summary: 'A local REST API and MCP server for Claude Code; AI changes undo in one click or wait for review' },
  { id: 'M8', title: 'Phone access', status: 'done', summary: 'Claude on your phone reaches the universe on your computer, through Tailscale Funnel and OAuth' },
  { id: 'M9', title: 'Power systems', status: 'done', summary: 'How magic, technology, faith or politics work on a world, age by age' },
  { id: 'M10', title: 'Inconsistency detector', status: 'done', summary: 'Claude reads a world and flags what contradicts itself; warnings in one panel' },
  { id: 'M11', title: 'Phone app', status: 'done', summary: 'The whole app on your phone, from your computer, through Tailscale' },
  { id: 'M12', title: 'Sync', status: 'done', summary: 'The same universe on several devices, synced directly over Tailscale' },
  { id: 'M13', title: 'Polish & release', status: 'active', summary: 'Right-click menus, update checks, livelier space, signed updates, a sample universe and shortcuts done; performance, signed installers' }
]
