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
  { id: 'M13', title: 'Polish & release', status: 'done', summary: 'Right-click menus, update checks, livelier space, signed updates, a sample universe, keyboard shortcuts, a performance pass' },
  { id: 'M14', title: 'Factions & relationships', status: 'done', summary: 'Factions with members and territory over time, who’s related to whom, a lane per character; spelling, shared power systems, one zoom from universe to ground, 12 km on the ground' },
  { id: 'M15', title: 'Rivers & erosion', status: 'done', summary: 'Rivers that run downhill and join, lakes in basins, each named and picked like a region, and land that wears down as time passes' },
  { id: 'M16', title: 'Plugins', status: 'done', summary: 'Your own generators, exporters and name generators, sandboxed, undone in one step; a manager and a template to start from; sub-factions as deep as they go' },
  { id: 'M17', title: 'The canvas, as Obsidian has it', status: 'done', summary: 'Text, element, picture and link cards, groups, labelled connections, colours, resizing, selection and the board’s tools' },
  { id: 'M18', title: 'Live collaboration', status: 'done', summary: 'Several people in one universe at once over their tailnets: shared by tailnet login, who’s in and where, merges field by field and undo per person' },
  { id: 'M19', title: 'Signed installers', status: 'active', summary: 'Installers signed and notarized as soon as the certificates are added, and the app locked to its own code' },
  { id: 'M20', title: 'Collaboration, part two', status: 'active', summary: 'Conflicts kept as notes, notes merged line by line and terrain cell by cell, an owner and members who can only look; next, tried on two real tailnets' },
  { id: 'M21', title: 'Sturdier underneath', status: 'done', summary: 'Undo per person for every change, sync’s work off the main thread, projects checked as they load, one stack for dialogs and menus, the canvas’s lines and exported pictures' },
  { id: 'M22', title: 'The ground, beautiful', status: 'done', summary: 'A sky with drifting clouds, land and sea to the horizon in a haze, wadis, ravines and ledges, rivers in valleys with waterfalls, lakes in basins' },
  { id: 'M23', title: 'Rough country', status: 'done', summary: 'Mountains, extreme hills and plains that swell, rough ground and sudden cliffs, denser woods to the horizon, and rising while looking the same way' },
  { id: 'M24', title: 'Languages', status: 'done', summary: 'Languages spoken by worlds, planets, star systems and regions, each with its sounds and naming rules for rivers, lakes, species, factions and planets' },
  { id: 'M25', title: 'Scarred land', status: 'done', summary: 'Craters, war, fire, drought, radiation and poison left on a world’s land at a time, healing over years, shown on the globe, the map and the ground and damaging what’s built' },
  { id: 'M26', title: 'Space, beautiful', status: 'done', summary: 'Galaxies painted from their shapes with dust lanes, nebulae, supernova remnants and named constellations, no web of lines, and nothing in space drawn over anything else' },
  { id: 'M27', title: 'Worlds up close', status: 'planned', summary: 'Reshape regions by their corners, seamless lighting on the globe, finer terrain close up' }
]
