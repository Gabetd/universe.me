# universe.me — Implementation Plan

A desktop worldbuilding application for writers and game designers. You build
worlds (terrain, vegetation, ecosystems, star systems, moon cycles), place
structures with attached notes, track history on a timeline, assign themes
that change over time, zoom out to galaxies and clusters to create more
worlds, and expose all of it to AI assistants such as Claude Code through an
API.

---

## 1. Goals and non-goals

### Goals (v1)
1. **Launchable desktop app** on Windows, macOS, and Linux (installer + double-click launch).
2. **Worlds** with geography, climate, vegetation, ecosystems, a star system, and moon cycles.
3. **Timeline per world**: past on the left, future on the right. Events can be added, linked by cause and effect ("A leads to B"), grouped into larger events, and pinned to places on the map.
4. **Scale navigation**: World → Star System → Galaxy → Galaxy Cluster → Universe, with the option to create new systems or worlds at any level.
5. **Themes per world, per time span**: a world can have several themes across its timeline.
6. **Visual editing**: sculpt and paint terrain, place structures, attach rich text to structures.
7. **Living structures**: events can build, damage, repair, or destroy structures. Each structure has a Maintained/Weathered toggle, and weathered structures erode over time until they're destroyed.
8. **AI access**: a local REST API and an MCP server, so Claude Code (or any MCP client) can read and edit worlds.

### Non-goals (v1)
- Multiplayer or real-time collaboration (keep the data model sync-ready, but don't build sync yet).
- Physically accurate simulation. Physics only needs to be good enough to tell consistent stories.
- Game-engine-level graphics. Aim for clean and readable, not photoreal.
- Cloud hosting. Everything is local-first.

---

## 2. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Desktop shell | **Electron** (TypeScript) | One language across UI, API, and MCP server. Mature packaging (electron-builder). Node in the main process makes the local API easy to run. *Alternative:* Tauri for smaller binaries, with the API/MCP server as a Node sidecar. |
| UI | **React + TypeScript + Vite** | Large ecosystem, good fit for editor-style UIs. |
| State | **Zustand** + command pattern | Simple stores. Commands give undo/redo and an audit log. |
| 3D rendering | **Three.js via react-three-fiber + drei** | Globe, star systems, and galaxy views. Logarithmic depth buffer and floating origin to handle huge scale ranges. |
| 2D map | **Canvas/WebGL layer** (PixiJS) over equirectangular projection | Fast painting and placement on a flat map view. |
| Timeline | Custom **Canvas/SVG** component (d3-scale, d3-zoom) | Needs custom zoom over very large time ranges, lanes, and link drawing. |
| Rich text | **TipTap** (ProseMirror) | Notes on structures, events, and entities, stored as HTML. @-mentions linking to other entities come later. |
| Storage | **SQLite** via Node's built-in `node:sqlite` + asset folder | One `.universe` project file. Transactional, queryable, and simple to back up. Built into Electron and Node, so there's no native module to rebuild per OS. FTS5 is included. |
| Validation / schema | **Zod** | One schema shared by the UI, REST API, and MCP tool definitions. |
| Local API | Node's **`node:http`** inside the Electron main process (`packages/api`) | REST + server-sent-event change feed, bound to 127.0.0.1. One table of operations serves REST and MCP. (Fastify and the MCP SDK were planned; a small server of our own keeps the app small, offline and in our hands. The SDK's client checks it in the tests.) |
| AI integration | **MCP server** (JSON-RPC over stdio + Streamable HTTP) | Plugs straight into Claude Code (`claude mcp add`). |
| Procedural gen | simplex-noise, seeded PRNG | Terrain, galaxies, and starfields that regenerate the same way from a seed. |
| Testing | Vitest (unit), Playwright (Electron E2E) | |
| Monorepo | pnpm workspaces | Add Turborepo once build times call for caching. |

---

## 3. Repository layout

```
universe.me/
├─ apps/
│  └─ desktop/              # Electron app (main + preload + renderer)
│     ├─ main/              # window mgmt, DB access, embedded API server
│     └─ renderer/          # React UI
├─ packages/
│  ├─ core/                 # domain model, Zod schemas, commands, queries (no UI)
│  ├─ db/                   # SQLite schema, migrations, repositories
│  ├─ sim/                  # orbital mechanics, calendars, climate/biome, ecosystem
│  ├─ procgen/              # seeded cube-sphere terrain, biomes, brushes, map rendering
│  ├─ timeline-ui/          # timeline React component
│  ├─ editor-3d/            # r3f scenes: globe, system, galaxy, cluster
│  └─ api/                  # the operations, served as REST + MCP (HTTP and stdio); thin layer over core
├─ docs/
└─ PLAN.md
```

**Rule:** all business logic lives in `packages/core`. The UI, REST API, and
MCP server only call core commands and queries, so every edit is validated,
undoable, and appears in all three the same way.

---

## 4. Domain model

### 4.1 Spatial hierarchy (the "zoom tree")

One tree of `SpatialNode` records with a `kind`:

```
Universe
 └─ GalaxyCluster        (position in universe, procedural seed)
     └─ Galaxy           (type: spiral/elliptical/irregular, arms, seed)
         └─ StarSystem   (position in galaxy, stars[])
             └─ Body     (planet | moon | asteroid belt | station; orbit params)
                 └─ World (surface data: terrain, biomes, structures, timeline)
```

- Every node has `id`, `parentId`, `kind`, `name`, `seed`, `position` (relative to the parent's frame), `notes`, and `tags`.
- A **Body** has orbital elements (semi-major axis, eccentricity, inclination, period, axial tilt, rotation period, radius, mass).
- A **World** is the editable surface layer attached to one Body. A body can exist without a world (it's just scenery).
- Procedural nodes (background stars, filler galaxies) are **not stored**. They regenerate from the parent's seed and only become stored when the user "claims" or edits one.

### 4.2 World content

| Entity | Key fields |
|---|---|
| `Terrain` | heightmap tiles (cube-sphere, quadtree LOD), sea level, seed |
| `BiomeMap` | painted/derived biome per cell; climate overrides |
| `Climate` | derived from latitude, tilt, elevation, ocean proximity; user overrides |
| `Species` | name, kind (flora/fauna/fungi/other), habitat biomes, diet, notes |
| `EcosystemLink` | predator → prey, pollinator, symbiosis, competition |
| `Region` | polygon on sphere (nations, forests, seas), properties |
| `Structure` | placement (lat/long/elevation/rotation/scale), blueprint, `builtAt`, `destroyedAt?` (manual, or derived from decay; see §4.7), `maintenance` (time-aware toggle), `condition` (derived), notes |
| `Blueprint` | reusable structure template built from parts/primitives or imported glTF; each part has a `material` |
| `Material` | stone, brick, wood, iron, steel, concrete, glass, magic/custom, etc. Each has a base durability (half-life of condition under neutral climate) and climate sensitivities (moisture, freeze-thaw, heat, salt, vegetation) |
| `Note` | rich text (TipTap JSON) attached to any entity via `ownerId` |

### 4.3 Time

- **Canonical time** is a count of seconds from the world's epoch (year 0), stored as a float64. Whole seconds are exact within ±285 million years, and deep-time dates (billions of years) keep far more precision than they could ever be known to. (Chosen over int64 so times stay plain JSON numbers end to end.)
- **Calendars** are derived from the simulation (day = rotation period, year = orbital period, months = moon synodic periods) and can be customized (named months, eras, leap rules). A world can have several calendars (e.g., two cultures).
- **Moon cycles** come from orbital params via `packages/sim`. Moon phase, eclipses, and tides can be shown at any timestamp and turned into timeline events automatically ("Total eclipse").

### 4.4 Timeline

| Entity | Key fields |
|---|---|
| `Event` | title, `start`, `end?`, `precision` (exact/day/year/century/era/approx), lane, color, notes, tags |
| `EventLocation` | event → point / region / structure (many-to-many) |
| `EventLink` | `fromEventId` → `toEventId`, type: `causes`, `enables`, `prevents`, `precedes`, `related`; optional note |
| `EventGroup` | composite event ("The Great War") containing child events; collapses into one bar on the timeline, expands to show its children |
| `Era` | named background span (e.g., "Age of Ice") shown behind the lanes |
| `EventEffect` | what an event *does* to the world: target (one structure, every structure in an area, a region, a species), effect type, and parameters. See §4.7 for structure effects. |
| `EntityChange` | time-bound change to any entity (structure built/destroyed, region border change, species extinction). This is what lets the map show the world "as of" a timestamp. Changes caused by an `EventEffect` point back to that effect, so the app can always answer "why does this look like this?" |

"Combining" events means two things:
1. **Causal chain**: events linked with `causes`/`enables`. The timeline draws arrows, and the app can highlight an event's whole upstream or downstream chain.
2. **Merging**: select several events → "Group" → creates an `EventGroup`, which can be expanded or collapsed.

Validation warns (but doesn't block) when an effect starts before its cause.

### 4.5 Themes

| Entity | Key fields |
|---|---|
| `Theme` | name, palette (sky, water, land, accent), lighting preset, fog/atmosphere, UI accent, typography, mood keywords, **prose style guide** (for AI), optional music/ambience tags |
| `ThemeSpan` | `worldId`, `themeId`, `start`, `end`, `regionId?`, `priority`, `blendIn`/`blendOut` durations |

- Several spans per world give a different theme at different points in time ("Golden Age" → "Plague Years" → "Rebirth").
- Spans can be limited to a region, and overlapping spans are resolved by priority.
- When the timeline playhead moves, the renderer blends between themes (palettes and lighting are interpolated over the blend window).
- Themes are also exposed to the AI, so generated text matches the tone of that era.

### 4.7 Structure condition: events, maintenance, and erosion

Every structure has a **condition** from 100 (pristine) to 0 (gone). Condition
is never stored as one number. It is **computed for any timestamp** from the
build date, the maintenance toggle, the local climate, and the events that
affected the structure. Scrubbing the timeline always shows a consistent
result, and editing any input (moving an event, changing climate) updates
everything after it.

#### Maintained / weathered toggle
- Each structure has a **Maintained** toggle, shown as a switch in the Inspector. Its default comes from the blueprint (a castle defaults to maintained, a standing stone to weathered).
- The toggle is **time-aware**. Flipping it while the playhead is at time *t* records a `MaintenanceChange { structureId, at: t, maintained: bool, causeEventId? }`, so a structure can be maintained for 300 years, abandoned, then restored.
- Rules:
  - **Maintained**: condition holds steady and slowly recovers toward 100 (repairs). Events can still damage it, and repairs then raise it back over time.
  - **Weathered** (not maintained): condition decays from erosion. Given enough time it reaches 0 and the structure is **destroyed by erosion**.
- A **"Never decays"** override exists for monuments the author wants to keep regardless (or for magic/sci-fi materials).

#### Erosion model (`packages/sim/decay.ts`)
- Decay rate per structure = material durability × climate factors at its location, all taken from data the app already has (§7):
  - moisture / precipitation
  - freeze–thaw cycles (temperature swings around 0 °C)
  - heat and UV
  - salt (distance to coast)
  - vegetation overgrowth (biome)
  - elevation and exposure
- Multi-material blueprints decay **per part**. Each part has its own rate, and the structure's condition is a weighted average. A stone keep with a wooden roof loses the roof first.
- Within each interval between breakpoints (build, maintenance change, event effect, climate change), condition follows a closed-form curve (exponential decay toward 0, or recovery toward 100). Condition at any *t* is a quick lookup over cached breakpoints, not a simulation loop, so thousands of structures stay fast while scrubbing.
- Climate is taken as of each interval, so a world getting wetter makes structures decay faster from that point on.
- All constants (material half-lives, climate weights, a global **"erosion speed"** slider per world) are user-editable. The defaults aim to be plausible, not exact: a wood cabin fades over ~1–2 centuries, a stone castle over several millennia, a pyramid over tens of millennia.

#### Condition stages
Thresholds drive visuals, labels, and auto-generated timeline markers:

| Condition | Stage | Visual |
|---|---|---|
| 90–100 | Pristine | clean materials |
| 70–90 | Worn | dirt, faded paint |
| 45–70 | Weathered | cracks, moss, missing small parts |
| 20–45 | Damaged | roof/upper parts gone, overgrowth |
| 5–20 | Ruin | walls only, heavy vegetation |
| 0–5 | Remnant | foundations, mounds |
| 0 | Destroyed | removed from view (optional "ghost" outline in edit mode) |

- Visual weathering uses shader parameters (grime, moss, crack masks) + **part removal**: blueprint parts are dropped in order of fragility as condition falls. Blueprints can also supply hand-made "ruin" variants per stage.
- When a structure crosses into **Ruin** or reaches **Destroyed by erosion**, the timeline shows **derived events** (dashed outline, auto-updated). The user can "promote" a derived event into a real, editable event to attach notes or causal links.

#### Events that affect structures
An `EventEffect` attaches to any event. Structure effect types:

| Effect | Parameters | Result |
|---|---|---|
| `damage` | amount (0–100) or "to stage X" | instant drop in condition |
| `destroy` | — | condition → 0 at event time |
| `repair` / `restore` | amount or "to pristine" | instant raise in condition |
| `build` | blueprint, placement | creates the structure at event time (sets `builtAt`) |
| `set_maintenance` | maintained: bool | records a `MaintenanceChange` (e.g., "City abandoned" turns off maintenance for every building in the city) |
| `modify` | property changes | e.g., renamed, change of owner, blueprint swap (keep expanded with a new wing) |
| `accelerate_decay` | multiplier, duration | e.g., a century of acid rain or a flood season |

- **Targets**: one structure, a list, everything in a region, or **everything within a radius** of the event's location, with optional falloff (an earthquake damages nearby buildings more than distant ones). Filters by tag/material ("all wooden buildings") let a fire burn the wooden quarter and leave stone walls standing.
- Effects of a grouped event (`EventGroup`) apply in the order of its child events.
- Causal links still work as before. An event that destroyed a structure can `cause` a later event ("Refugees found a new town").

#### UX
- **Inspector → Condition panel**: a condition-over-time sparkline from `builtAt` to the end of the timeline. Breakpoints are marked (events, maintenance flips) and clickable to jump the playhead there. A projection for the future shows when it will become a ruin or be destroyed if left weathered.
- **Timeline**: selecting a structure shows a thin condition track under its lifespan bar. Event bars with structure effects show a small icon (hammer = build/repair, crack = damage, skull = destroy).
- **Map filter "Condition"**: tints structures by stage, so you can see at a glance what's in ruins at any moment.
- **Placing an event** with a radius effect shows a preview of which structures will be hit and how badly, before you confirm.

#### Consistency checks (added to `check_consistency`)
- An event located at a structure *after* the structure has been destroyed (by erosion or an event).
- A `repair` on an already-destroyed structure (suggest `build` / rebuild instead).
- A structure marked maintained during a span when its region has no population/faction (warning only).

### 4.8 Cross-cutting

- Every record has `id` (UUIDv7), `createdAt`, `updatedAt`, and `deletedAt` (soft delete), so a sync layer can be added later.
- Every write goes through a **Command** (`{type, payload, inverse}`), which provides undo/redo, history, and API audit logs.
- Full-text search (SQLite FTS5) over names, notes, and event text.

---

## 5. Application UX

### 5.1 Main layout
```
┌──────────────────────────────────────────────────────────────┐
│ Breadcrumb: Universe › Virgo Cluster › Milky Way › Sol › Earth│
├─────────┬──────────────────────────────────────┬─────────────┤
│ Outline │                                      │ Inspector   │
│ (tree)  │        Viewport (3D / 2D map)        │ (selected   │
│         │                                      │  entity,    │
│         │                                      │  notes)     │
├─────────┴──────────────────────────────────────┴─────────────┤
│ Timeline  [past ◄────────────●playhead────────────► future]  │
│ lanes / eras / theme spans / event bars / causal arrows      │
└──────────────────────────────────────────────────────────────┘
```

### 5.2 Scale navigation (zoom out/in)
- Scroll or pinch zooms continuously. Crossing a threshold switches levels: **Surface → Orbit (planet + moons) → Star System → Galaxy → Cluster → Universe**.
- Each level is its own r3f scene with its own units (km → AU → light-years → megaparsecs), joined by animated transitions with a floating origin. This avoids floating-point precision problems.
- At each level, the context menu offers: **New star system here / New planet / New moon / New world on this body / Claim this procedural star**.
- The breadcrumb always shows where you are and lets you jump to any level.

### 5.3 Visual world editor
- **Globe view** (3D) and **Map view** (2D equirectangular), switchable.
- Tools: raise/lower/smooth/flatten terrain, set sea level, paint biome, draw region polygon, place structure, measure.
- **Auto-suggest**: biomes come from climate (Whittaker diagram), and vegetation/species lists come from biomes. The user can override anything.
- **Structures**:
  - Place from a blueprint library (castle, tower, city, bridge, road/wall as polylines).
  - **Blueprint builder**: combine primitives (box, cylinder, cone, arch, wall segment), set materials and colors, save as a reusable blueprint. glTF import for custom models.
  - Each structure has a **notes panel** (rich text, images, @-links to events, species, other structures) and a lifespan tied to timeline events (built in X, destroyed in Y).
  - Each structure has a **Maintained / Weathered** toggle and a condition panel (§4.7). Unmaintained structures visibly age and eventually erode away.
  - Text labels/plaques can be shown in the viewport as callouts above structures.
- **Time-aware view**: the viewport shows the world as of the playhead. Structures appear, weather, crumble and disappear, borders change, and the theme blends.

### 5.4 Timeline UI
- Horizontal, **left = past, right = future**, with a "Now" marker the user can set.
- Smooth zoom from seconds to billions of years (piecewise or log scale). Labels use the world's calendar.
- Lanes (by category, region, or character), drag to move or resize events, double-click to create.
- Drag from one event's connector to another to create a **causal link**. Arrows are drawn between bars.
- Multi-select → **Group** to create an `EventGroup` (collapsible).
- Theme spans show as a colored band above the lanes. Eras show as background shading.
- Clicking an event highlights its locations in the viewport, and the structures it affects. Clicking a structure or region filters the timeline to its events.
- An event's **Effects** tab lists what it does to structures (damage, destroy, repair, build, abandon/maintain). Effects can be added there or by dragging the event onto a structure in the viewport.
- Moon phases and eclipses can be shown as an optional track.

### 5.5 Ecosystem & star-system panels
- **Ecosystem**: species table + node-graph food web (React Flow), filterable by biome or region.
- **Star system**: orbit diagram, editable orbital params, derived values (day/year length, seasons, moon phase calendar), plus a "habitable zone" overlay.

---

## 6. AI integration (API + MCP)

### 6.1 Local REST API
- Runs inside the app at `http://127.0.0.1:47615` (or the next free port) and starts with the app; Connect AI turns it off and on.
- Auth: a bearer token for the app (it serves whichever project is open), kept in a file only the user can read and shown in Connect AI, where a new one can be made.
- OpenAPI description generated from the operations' Zod schemas, at `GET /v1/openapi.json`.
- Endpoints (all under `/v1`), one per operation; reads are GETs with inputs in the query, writes POSTs with a JSON body. For example:
  - `GET /worlds`, `GET /tree`, `GET /worlds/:worldId`, `GET /search?q=`
  - `GET /worlds/:worldId/events?from=&to=&tags=`, `POST /worlds/:worldId/events`, `GET /events/:eventId/chain`, `POST /event-links`, `POST /event-groups`
  - `GET /worlds/:worldId/structures?at=&regionId=&stage=`, `GET /structures/:structureId/condition?at=` (condition, stage and why), `POST /structures/:structureId/maintenance`, `POST /events/:eventId/effects`
  - `GET /worlds/:worldId/theme?at=&regionId=`, `POST /themes`, `POST /worlds/:worldId/theme-spans`
  - `GET /worlds/:worldId/snapshot?at=`: the world at a moment (events happening, regions, structures standing with condition, characters alive, the theme in force, moon phases)
  - `GET /worlds/:worldId/export?format=markdown|json`: the "world bible"
  - `POST /commands`: any core command (or several, as one undo step)
  - `GET /changes`: the change feed, as server-sent events (what changed, and whether the app or an AI client changed it)

### 6.2 MCP server (`packages/api`)
Two ways to run it:
- **stdio**: `Universe --mcp --project ~/Worlds/Aerth.universe` (the app's own executable). It goes through the running app while the app has that project open, and otherwise opens the SQLite file directly, locked for each message.
- **HTTP**: `/mcp` on the running app (Streamable HTTP, answering with JSON).

Registration in Claude Code (Connect AI shows both with the real paths and token):
```bash
claude mcp add --transport http universe http://127.0.0.1:47615/mcp --header "Authorization: Bearer <token>"
claude mcp add universe -- /Applications/Universe.app/Contents/MacOS/Universe --mcp --project ~/Worlds/Aerth.universe
```

**Tools** (each one is a thin wrapper over a core command or query):
- Read: `list_worlds`, `get_world`, `get_world_snapshot(at)`, `search`, `list_events(range, tags)`, `get_event_chain(eventId, direction)`, `get_theme_at(worldId, time, regionId?)`, `list_structures(regionId?, at?, stage?)`, `get_structure_condition(structureId, at)` (condition, stage, and *why*: the events and decay behind it), `get_ecosystem(biome?)`, `get_star_system`, `get_moon_phase(worldId, time)`; also `get_tree`, `get_event`, `list_themes`, `list_blueprints`, `list_characters`, `export_world_bible`, `describe_commands`
- Write: `create_event`, `add_event_effect`, `link_events`, `group_events`, `create_structure`, `set_maintenance(structureId, at, maintained)`, `update_note`, `create_species`, `create_theme`, `assign_theme_span`, `create_world`, `create_star_system`; also `update_event`, `create_character`, `create_region`, `link_species`, and `run_commands` for any core command
- Analysis: `check_consistency` (effects before causes, structures used before they're built or after they've eroded, species outside their habitat), `project_decay(structureId)` (when it will become a ruin or be destroyed if left weathered)

**Resources**: `universe://world/{id}`, `universe://world/{id}/timeline`, `universe://world/{id}/bible.md`. These let the AI load context without many tool calls.

**Prompts**: `write_scene(worldId, time, locationId)` (pulls the snapshot + active theme style guide), `brainstorm_history(worldId, range)`.

### 6.3 Safety and UX for AI edits
- AI writes are tagged `source: "ai"` in command history and can be undone in one step.
- Optional **"review mode"**: AI writes land as *proposals* that the user accepts or rejects in the app.
- A toast notification shows in the app whenever an external client changes something.

---

## 7. Simulation details (`packages/sim`)

Keep it simple and deterministic:
- **Orbits**: Keplerian two-body per body around its parent, solving Kepler's equation for position at time *t*.
- **Day/year/seasons**: from rotation period, orbital period, and axial tilt. Insolation per latitude per day of year.
- **Moon phases**: from the Sun–planet–moon angle. **Eclipses**: line-of-sight + angular size check. **Tides**: relative magnitude only.
- **Climate**: latitude bands + elevation lapse rate + simple ocean/continental moderation → temperature & precipitation → **Whittaker biome**.
- **Ecosystem**: species valid per biome; simple trophic-level checks (prey needs to exist in the same biome). No population dynamics in v1.
- **Structure decay**: closed-form condition curves per structure part from material × local climate × maintenance state, with event effects as step changes (§4.7).

---

## 8. Persistence

- One project = one `.universe` file (SQLite) + a sibling `.universe-assets/` folder (textures, glTF, images). An optional "package" export zips both.
- Migrations are versioned in `packages/db`.
- Terrain stored as compressed heightmap tiles (BLOB, zstd) per quadtree node.
- Autosave on every command (SQLite WAL), plus periodic snapshot backups.
- Export/import: JSON (lossless), Markdown world bible (for reading and for AI), PNG map renders.

---

## 9. Milestones

Each milestone ends with something you can launch and demo.

### M0 — Foundations (1–2 weeks) — *done*
- [x] Monorepo, Electron + Vite + React skeleton, CI (lint, typecheck, test, e2e, build installers for Windows/macOS/Linux).
- [x] `core` command bus with undo/redo, Zod schemas, SQLite + migrations, command history log.
- [x] Create/open/save-a-copy `.universe` project, recent projects. Main layout (breadcrumb, outline, viewport, inspector, timeline placeholder).
- [x] Universe tree editing (cluster → galaxy → system → planet → moon/world) with a seeded 2D placeholder viewport.
- [ ] Code signing (Windows certificate, Apple Developer ID). Deferred to M8; builds are unsigned until then.
- [x] *Added after M2:* self-update. Each CI build is versioned `0.1.<run>` and publishes an `update.json` manifest (file names, sizes, SHA-512) with the installers. The app checks it at launch and hourly (and from Help → Check for Updates); a dismissable banner offers the new version, and **Upgrade now** downloads, verifies and installs it, then restarts, with no further input: NSIS installer run silently, portable exe swapped, macOS `.app` replaced from the zip, AppImage replaced in place. A `.deb` install needs the system password (root).
- [x] *Added after M2:* local only. All data lives in the project's SQLite file (built into the app via `node:sqlite`, no server). The main process cancels every network request except the app's own files and the self-updater's download from this repo's GitHub release; pages can't reach the network at all, and links open in the browser instead of the app window.

### M1 — Worlds & globe (2–3 weeks) — *done*
- [x] Create world on a body; procedural terrain from seed on a cube-sphere (6 × 256² cells, generated in a Web Worker); globe + 2D map views.
- [x] Terrain sculpt tools (raise, lower, smooth, flatten), sea level, biome painting/erasing, region polygons. Each stroke is one undoable command.
- [x] Inspector + rich text notes (TipTap, stored as HTML) on nodes and regions; world generation settings.
- Storage: terrain is saved as *edits on top of the generated base* (Int16 height deltas + painted biome ids, zlib-compressed per face), so changing the seed or generation settings keeps the user's sculpting.
- Deferred: dragging region vertices to reshape (redraw for now), seamless lighting across cube-face edges, quadtree LOD for close-up detail.
- [x] *Added after M2:* world options and seeds. Options: land type (continents, supercontinent, archipelago), exact water coverage, continent size, islands, mountain amount and height, roughness, temperature, deserts, beaches, vegetation/sand/water colors, and size. A **seed** (any text) generates the whole world, options included, and locks them; "Customize" unlocks them. A **world code** (`W1-…`, with a check character) encodes a world's noise seed and every option exactly, so any world can be recreated anywhere. Presets for custom worlds (ocean, desert, ice, jungle, alien…).

### M2 — Timeline (2–3 weeks) — *done*
- [x] Timeline component: zoom/pan from minutes to billions of years, lanes, eras, create/move/resize events, a "Now" marker and a playhead. Dates are typed freely ("1204", "15 Mar 1204", "c. 1200", "13th century", "4.5 billion years ago") with a precision.
- [x] Event locations (point/region) with map ↔ timeline highlighting: pins on the globe and map, the selected event's regions highlighted and the globe turned toward it; selecting a region highlights its events.
- [x] Causal links with arrows (drag between events); event groups (collapse/expand); consistency warnings (effect before cause, causal loops, changes outside their cause's time, events in regions that don't exist yet).
- [x] Playhead drives a time-aware viewport (`EntityChange`): regions are founded, renamed and dissolved over time, each change optionally caused by an event.
- Storage: every timeline record kind lives in one `records` table as JSON. A `batch` command applies several commands as one undo step (used for grouping and cascading deletes).
- Deferred: reshaping region borders over time (needs vertex editing), reordering lanes by drag, calendars from the star system (M4; an Earth-like default until then).
- [x] *Added after M2:* a **canvas** per world. Every event on the world's timeline is a node there automatically (laid out in time order until moved); nodes can be dragged, hidden (and shown again), and linked by dragging from one onto another (the same causal links as the timeline). As the playhead moves on, finished events recede into the distance (smaller, dimmer, drawn toward the vanishing point) but stay clickable. Clicking a node goes to when and where it happened: playhead to its start, timeline scrolled to it, and the globe or map turned to its point or region.

### M3 — Structures (2 weeks) — *done*
- [x] Blueprint library + primitive-based blueprint builder (box, cylinder, cone, pyramid, sphere, gable roof; material, colour, size, position, turn; live 3D preview that can be aged); glTF import, stored inside the project file.
- [x] **Prebuilt blueprints**, generated in code with fixed seeds: stone castle, motte and bailey, hilltop citadel, a vast walled city (≈2,500 parts: walls, towers, citadel, cathedral, palace, market square, streets of houses, fields), village, slum quarter, war camp, nomad camp, harbour town, cathedral, palace, arena, farmstead, windmill, mine, watchtower, house, temple, lighthouse, stone bridge, standing stone, stone circle, ziggurat, pyramid. Drawn with instanced meshes so big ones stay fast.
- [x] Place (built at the playhead), move, rotate and scale structures; lifespans tied to events (build/destroy effects); notes, tags and in-viewport labels on the globe and map.
- [x] **Event effects on structures**: build/damage/destroy/repair/modify/set_maintenance, reaching chosen structures, a region, or a radius around the event with optional falloff, filtered by tag or material; live preview of what each effect reaches (and by how much) in the inspector and as rings in the viewport; timeline effect icons.
- [x] Maintained/Weathered toggle (time-aware `MaintenanceChange`) and condition stages, with a fixed decay rate per material (half-lives from thatch at 25 years to megaliths at 10,000) and a per-world erosion speed, until climate exists in M4. Condition is closed-form between breakpoints; weathered structures erode away in finite time, maintained ones recover. Parts fall away in order of fragility as condition drops; colours weather; ruins slump.
- [x] Consistency warnings: effects that reach nothing, repairs of structures already gone, maintenance changes before a structure is built.
- [x] *Added after M3:* **ground view** (the Surface level of §5.2, ahead of M5). Scrolling all the way in on the globe or map (or the 🔍 Ground button, or "View up close" on a structure or character) goes down to the ground: terrain in 1 km × 1 km chunks on a global grid, each with metre-scale hills on top of the globe's terrain and the plants of its biome (broadleaf and conifer woods, palms, acacias, bushes, grass, flowers, cacti, reeds, rocks, dead trees), gathered into woods and clearings, all from the world's seed so a spot always looks the same. Chunks are built in a Web Worker, 5 × 5 around the view, thinner farther out; structures stand at their real size (plants keep clear of standing ones, ruins are overgrown), and the view re-centres as you travel. Scrolling all the way out returns to the globe. From afar, structures are pins coloured by condition, not models.
- [x] *Added after M3:* **planets from orbit** show their world's real surface (rendered from its terrain, turning slowly) in the planet/moon and star-system views.
- [x] *Added after M3:* **characters** on a world: born and died dates (age at the playhead), and a journey of stops. Send one somewhere with 🧭 (they arrive at the playhead, setting out on foot early enough at 30 km a day) or to an event (a stop at its start and place); in between they walk the great circle. Shown at the playhead as figures on the globe and map and life-size on the ground. Deleting an event unlinks the stops that went to it. (Per-character timelines and relationships stay post-v1, §12.)

### M4 — Star systems & sim (2–3 weeks) — *done*
- [x] **Star systems** (`packages/sim`): a star per system (mass; brightness, temperature, colour and habitable zone derived, or set) and Keplerian orbits for planets and moons (distance, eccentricity, inclination, start angle, day length, axial tilt, mass). Bodies nobody has edited get seeded defaults (a world's planet starts out Earth-like, a moon Moon-like). The system and planet views draw them where they are at the timeline's playhead, with the habitable zone, each moon's phase, and play controls (a day, month or year a second) that move the playhead.
- [x] **Derived calendars**: day from the spin relative to the star, year from the orbit, months from the largest moon's synodic month (rounded to whole minutes and days, so an Earth-like world gets exactly the Earth calendar). Every date in the app is written and read in the world's calendar once its planet's orbit is set; month names can be changed.
- [x] **Moon phases and eclipses** as a track on the timeline (new and full moons, solar and lunar eclipses, total, annular or partial, from the shadows' geometry); an eclipse becomes an event with a click.
- [x] **Climate → biomes**: the star's brightness and the planet's distance set the average temperature against Earth's, and the axial tilt how strongly it cools toward the poles; automatic biomes follow (a world pushed outward grows ice caps and tundra). A climate panel shows temperatures by latitude and the seasons.
- [x] **Species library + food web**: species per world (kind, diet, biomes, notes), links (eats, pollinates, lives with, competes with), a food-web graph from producers to predators, suggestions from a built-in catalogue for the biomes the world actually has, and warnings (predators with nothing to eat, prey in no shared biome).
- [x] **Climate-driven erosion**: every material of a structure decays on its own (condition is their average by volume), at its half-life sped up or slowed by the weather where it stands (moisture, freeze–thaw, heat, sea salt, plant growth, from the terrain and climate): a thatched roof is gone while the stone chimney stands; wood rots in a rainforest and lasts in a desert; iron rusts by the sea. Parts fall by their own material's condition; moss and grime come with age in the shader. Derived "falls into ruin" and "erodes away" milestones on the timeline (click one to make it an event); a condition chart over the structure's life with its projection.
- Deferred: climate changing over time (sea level and temperature are fixed per world), atmospheres and greenhouse strength, eclipses seen from a particular place, the moon's nodes precessing.

### M5 — Scale navigation (2–3 weeks) — *done*
- [x] **Seeded levels** (`packages/procgen` cosmos.ts): a universe's seed strings 48 galaxy clusters along a cosmic web; a cluster holds 36 galaxies, crowded toward its middle; a galaxy is spiral, barred, elliptical or irregular (arms, bulge, size and tint from its seed), its stars generated in 600 ly cells as you get close (same cell, same stars: mostly red dwarfs, a few giants), with bright landmark stars from afar; a star system's seed makes two to eight planets, rocky inside the frost line, giants outside, closer in round dimmer stars (`packages/sim`).
- [x] **Seamless zoom**: the universe, clusters and galaxies are maps to pan and zoom, each in its own units (Mly for the universe and clusters, ly in a galaxy), so positions stay precise at every level (the floating origin). Scrolling all the way in on something goes into it and all the way out goes up; the old view freezes and flies past (or falls away) while the next arrives from the same point. Each level keeps its camera, and coming up opens on the child you left. The breadcrumb and Esc zoom out the same way; the wheel waits for one zoom to finish before the next.
- [x] **Create/claim at any level**: anything generated can be claimed (a cluster, a galaxy, a star with its mass, a planet with its orbit and, for rocky ones, a world surface its size), keeping its seed and place, so claiming changes nothing you saw; claimed things are ringed and named. Right-click to claim, open, or put a new one of your own anywhere.
- Deferred: generated moons for claimed planets, nebulae and dust lanes, a 3D galaxy (it's a top-down map), and a keyboard way through the generated items on the maps.

### M6 — Themes (1–2 weeks) — *done*
- [x] **Theme editor** (`packages/core` themes.ts): a project-wide theme library, each theme with a palette (sky, water, land, accent), a lighting preset (day, golden, overcast, dusk, night, storm), how hazy its air is, a typeface for titles, mood words, ambience tags, a prose style guide for writers (and, from M7, the AI) and notes; six presets to start from (Golden Age, Plague Years, Ice Age, Twilight, Age of War, Verdant). Deleting a theme takes its spans with it, in one undo step.
- [x] **Theme spans on the timeline**: a theme band above the lanes, one bar per span (from, to, the whole world or one region, a priority, fade-in and fade-out times), stacked by priority and fading at its ends; drag a bar to move it, its ends to resize it, double-click the band to add one. The world's inspector shows what's in force at the playhead, how much of each, and its mood and style guide.
- [x] **Blending as the playhead moves**: spans composite like layers of paint (eased over their fades, higher priority on top), and the views follow: on the globe the sunlight, sky light, halo, sea and land; on the ground the sky, fog, light, sea and land, with the themes of the region it's in; on the map the theme's light and land, and inside each region with themes of its own, those. The interface takes on the accent and title type of the theme in force.
- Deferred: a region's own themes on the globe (they show on the map and the ground), where two regions with themes of their own overlap on the map (the later one's shows there), ambience sounds, and theme images.

### M7 — API & MCP (2 weeks) — *done*
- [x] **REST API** (`packages/api`): one table of operations (38: 21 reads such as worlds, a world at a moment, search, events and their causal chains, the theme in force, structures' condition and why, decay, the ecosystem, star systems, moon phases, consistency; writes as thin wrappers over core commands, plus `run_commands` for any command) served under `/v1` on 127.0.0.1, with an OpenAPI description made from their Zod schemas and a change feed as server-sent events. Every request needs the bearer token; requests from web pages (an Origin header) and for other hosts are turned away. Dates are written in the world's calendar ("15 Mar 1204"), notes as plain text.
- [x] **MCP server**: every operation as a tool (read-only ones marked so), each world's overview, timeline and bible as resources, `write_scene` and `brainstorm_history` prompts. Over HTTP at `/mcp` in the running app, and over stdio as `Universe --mcp --project <file>`, which goes through the app while it has the project open and otherwise opens the file itself, locked, one message at a time. The Connect AI panel gives both `claude mcp add` commands (see the README).
- [x] **AI changes**: tagged as the AI's in the command history, shown at once with a note, taken back in one click (Undo AI); in review mode they wait as suggestions to accept or reject.
- [x] **World bible**: a world as one Markdown document (calendar, regions, history in order, structures, characters, life, the tone of each age), from the world's inspector, the API and an MCP resource.
- Deferred: the token in the OS keychain (it's in a file only the user can read), WebSockets for the change feed (server-sent events do it with less), `universe serve` without the app (the stdio server covers headless use), suggestions kept across restarts, review mode for the stdio server while the app doesn't have the project open (it writes to the file directly then), accepting all suggestions in one step, and a region's notes and changes over time in the bible.

### M8 — Polish & release (2 weeks)
- Onboarding sample universe, keyboard shortcuts, performance pass (LOD, instancing for structures).
- Signed installers (Windows NSIS, macOS dmg + notarization, Linux AppImage/deb); auto-update already works unsigned (see M0) and should move to signature-checked updates once signed.
- E2E tests for the main flows.

**Rough total: 19–25 weeks** for one full-time developer. M7 (API/MCP) can be pulled earlier, right after M2, if AI assistance is wanted sooner. The core layer makes it cheap to add.

---

## 10. Testing strategy
- **Unit**: core commands (do/undo symmetry), sim math (known Earth/Moon values), time/calendar conversions, consistency checks.
- **Decay**: condition is continuous across breakpoints; maintained structures never reach 0 without a destroying event; weathered ones always do eventually (unless "never decays"); moving or deleting an event updates every later condition; results are deterministic for the same inputs.
- **Integration**: API and MCP tools against a temp SQLite project; schema round-trip (export → import → equal).
- **E2E (Playwright + Electron)**: create world → paint → place structure → add linked events → assign theme → scrub playhead → verify view.
- **Visual regression**: screenshot tests for the globe/timeline at fixed seeds.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Precision problems across km ↔ megaparsec scales | Separate scene per scale level, floating origin, logarithmic depth buffer, int64 time. |
| Timeline performance with thousands of events | Canvas rendering, spatial index by time range, virtualized lanes, level-of-detail clustering when zoomed out. |
| Terrain editing on a sphere is complex | Start with cube-sphere heightmap tiles + brush stamping. Defer erosion/rivers to post-v1. |
| Decay recomputation when scrubbing or editing with many structures | Closed-form curves between cached breakpoints. An edit only invalidates structures it targets, and only after its timestamp. Condition for visible structures is computed in a Web Worker. |
| Erosion results that feel wrong for the story | Per-world erosion speed slider, editable material half-lives, per-structure "never decays", and manual damage/repair events to correct any outcome. |
| Scope creep (simulation depth) | Sim is "plausible, deterministic, overridable". Every derived value can be manually set. |
| AI edits corrupting data | All writes validated by Zod + core invariants, tagged and undoable, optional review mode. |
| Electron bundle size | Acceptable for v1. Tauri migration path is possible because the logic lives in framework-agnostic packages. |

---

## 12. Post-v1 ideas
- Factions, relationship graphs between characters, and per-character timeline lanes (characters with lifespans and journeys exist since M3).
- Rivers/erosion simulation, plate tectonics over time.
- Cloud sync and collaboration (CRDT over the command log).
- Image generation for structures/themes via AI; ambient soundscapes per theme.
- Plugin system for custom generators and exporters (e.g., to game engines).

---

## 13. Immediate next steps
1. Confirm the stack (Electron vs. Tauri) and the v1 scope above.
2. Scaffold M0: monorepo, Electron app shell, `core` + `db` packages, CI.
3. Write the Zod schemas for §4 and the first migration. Everything else builds on them.
