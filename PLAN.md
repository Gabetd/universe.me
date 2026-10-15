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
9. **From the phone**: Claude on a phone (a claude.ai custom connector) reaches the universe open on the user's computer, through a tunnel the user turns on.

### Non-goals (v1)
- Multiplayer or real-time collaboration (keep the data model sync-ready, but don't build sync yet).
- Physically accurate simulation. Physics only needs to be good enough to tell consistent stories.
- Game-engine-level graphics. Aim for clean and readable, not photoreal.
- Cloud hosting. Everything is local-first: the project stays on the user's computer, and phone access goes to it there (the tunnel carries the traffic, it stores nothing).

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

### 4.6 Power systems

How powers work, age by age: magic, divine gifts, technology and energy, political power, or anything else. Systems are the universe's, a library every world shares: each holds where it's pinned, on a node (a planet, a star system, a galaxy, the universe) and everything in it, or on an era of any timeline (its entry for that age). Any number hold on a world.

| Entity | Key fields |
|---|---|
| `PowerSystem` | `ownerId` (the universe), `pins` (the nodes it holds on), name, `template` (magic, divine, psionic, technology, political, other), color, summary, `aspects` (the questions it answers, from its template and editable: Source, Rules, Costs & limits, Who can use it…), `values` (what's true in every age, per aspect), notes |
| `PowerAge` | `ownerId` (its era's timeline), `systemId`, `eraId` (an age is an era), `values` (what's different in that age, per aspect; an aspect left empty keeps the always-true answer), `strength` (0–1 or unset: how strong or widespread it is then), summary |

- The Powers page lists the systems; one shows its aspects for **Always** and for each era in time order, with the era under the playhead marked, and how its strength rises and falls across the ages.
- Deleting an era takes its age entries with it (undo brings both back). Era changes don't move anything else: an entry follows its era.
- The API reads a system at any moment (the always-true answers with that age's on top), and it goes into the world bible and `write_scene`.

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

### 6.5 Inconsistency detector (with a connected AI)

The app's own checks (`check_consistency`) catch mechanical mistakes: effects before causes, loops, structures used before they're built. What only a reader can catch — a character in two places at once, magic used in an age where it's gone, a festival in a season the calendar doesn't have, a region's history that contradicts its notes — the connected Claude finds.
- `review_consistency` (an MCP prompt, also a button that copies it): asks Claude to read a world (snapshot, timeline, bible, power systems) and report each problem with `report_inconsistency`.
- `report_inconsistency(worldId, severity, title, explanation, refs[], suggestion?)` stores a **finding**: a record in the project, so it's undoable, kept with the world and seen by every device. `list_inconsistencies` lets Claude skip what it reported before.
- In the app: a **Warnings** panel lists the app's own warnings and Claude's findings together, each linking to what it's about (opening it, or its right-click menu); a finding can be resolved (kept, marked fixed) or dismissed (not a problem; Claude is told not to raise it again). Elements with an open finding show an amber mark in the tree, the timeline and the inspector.
- When Claude changes something, a finding about it isn't cleared on its own: Claude (or the user) resolves it.

### 6.4 From the phone (remote MCP)
Claude on a phone can't reach `127.0.0.1`: a claude.ai custom connector (added once on claude.ai, then on every device signed in to it, the phone app included) is called from Anthropic's servers, so it needs a public HTTPS address with a real certificate, and OAuth instead of a pasted token.
- **Tunnel: Tailscale Funnel.** The app keeps listening on 127.0.0.1 only. The user installs Tailscale and signs in; Connect AI finds it, turns on Funnel for the API's port (`tailscale funnel --bg <port>`, or the user runs it) and shows the public address, `https://<computer>.<tailnet>.ts.net/mcp`, to add as a custom connector on claude.ai (Settings → Connectors). Funnel forwards to the app with the public host in `Host`; the app accepts that host and no other. Phone access can be turned off in the app (it then turns away every request for the public host) and Funnel turned off from the same place.
- **OAuth 2.1** (the MCP authorization spec, 2025-06-18): protected-resource and authorization-server metadata, dynamic client registration, authorization codes with PKCE (S256), access tokens (an hour) and rotating refresh tokens (90 days unused). The sign-in page is the app's own (no scripts, nothing from elsewhere): it asks for a code the app shows on the computer, so only someone who can see the app's screen can connect a device. Five wrong tries and the request is void; requests last ten minutes.
- **Devices**: each connected client is listed in Connect AI with when it was added and last used, and can be removed (its tokens stop working at once). Tokens are kept hashed, in a file only the user can read.
- The same operations, notes, Undo AI and review mode as on the computer: a phone's writes are the AI's like any other client's. The REST API answers OAuth tokens too.
- The computer has to be on with the app running; otherwise the connector says it can't reach the server.

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

### 6.6 The phone app (a web app from the computer)

The app the computer runs, in the phone's browser (installable to the home screen), through Tailscale. The computer has to be on.
- **Served by the app**: the renderer's own build, from a server of its own in the app (not the API's), with a web bridge in place of Electron's: the same `UniverseApi` methods as HTTP calls and its events as a server-sent stream. Nothing loads from elsewhere; the page's Content-Security-Policy allows only itself.
- **Tailnet only**: `tailscale serve` (not Funnel) on its own port, so only devices signed in to the user's tailnet can reach it; requests must carry Tailscale's `Tailscale-User-Login` of the tailnet's owner. Funnel stays for claude.ai alone.
- **Signed in once per device** with a code the computer shows (as for Claude), then a session cookie (HttpOnly, Secure, SameSite=Strict, 90 days unused); each phone is listed with the connected clients and can be removed.
- **Phone layout**: below 700 px the workspace becomes tabs (Tree, View, Details, Timeline) with touch controls: drag to turn the globe and pan the map, pinch to zoom, long-press for the right-click menu.
- One project at a time: the one open on the computer. Edits go through the computer's command bus, so undo and history are shared.

### 6.7 Sync between devices (over Tailscale)

The same universe on several computers (and through them, phones), with no cloud: devices on the user's tailnet sync with each other directly.
- **Who**: the user's own devices (and other people's a universe is shared with: see **With other people**). With **Sync with my other devices** on (Connect AI, or the start screen), Universe asks each online peer in `tailscale status` that belongs to the same tailnet user, at its tailnet name on the phone app's `tailscale serve` port. That server answers sync only for requests that `tailscale serve` marks as the owner's (and never Funnel's), with a sync header no web page can send. No pairing step: the tailnet login is the proof.
- **Sharing a universe**: each device says what it has open (a sync id made when the universe was created, and its name). **Copy here** on another device makes a new file and pulls every row into it; from then on the two have the same sync id and keep each other up to date while both have it open.
- **What syncs**: rows, not commands. Every row (nodes, records, regions, world settings, terrain tiles, assets) carries a hybrid logical clock stamp from the device that last wrote it (`StampedStore`, stamped as a transaction commits), and each copy numbers the rows as it gets them, so a device asks another for the rows it got since it last asked (but its own). The later stamp wins, per field (below); deletes are soft, so they sync too. A merge is one `sync.merge` command: checked like any write and logged, but not on the undo stack, so undo stays per device and works on what it sees.
- **When**: every 10 seconds while both are online, and at once after a change (the changed device nudges the others); otherwise the next time they meet. Connect AI lists each device, what it has open and when they last synced.
- **Per field** (M18): a row of fields (a node, a world's settings, a region, a record; not terrain or files, which are bytes) keeps a stamp for each field too, down into nested objects (so `terrain.water` and `terrain.roughness` are two), in the project file beside the row's (migration 8, only those that differ from it) and on the wire as a row's optional `fields` (a copy from before sends none: every field at the row's stamp). A write stamps only the fields it changed, and one that changes nothing isn't stamped or sent again. A merge keeps, field by field, the version with the later stamp, so two people changing different fields of one event (or different sliders of one world) both keep their change; a delete is a field too, so a change made as another device deleted the row is there when it's brought back. A version later in every field is taken whole; a mix of both is a new row stamped by the device that merged it, which the others then take whole, so nothing goes round for ever. A mix that isn't a valid row (a canvas card taken off on one device as it was moved on the other) falls back to the later row, whole.
- **Changes made apart** (M20): each field's stamps say what it was written over (its *lineage*: the stamps of the versions before it, newest first, up to eight, kept with the row's stamps in the project file, migration 9, and sent as a row's optional `lineage`; a row from before knows its fields' from its next write on, and one from a device from before knows none). A merge then tells a change made on top of another (taken as it is) from two made apart (`lineage.ts`):
  - **Notes** (a `notes`, a change's `note`, a canvas card's `text`) changed apart are merged line by line (a line ends after a paragraph, heading, list item, line break or new line) from the version both came from (`line-merge.ts`): each device keeps the versions of its notes it wrote over while they're in the line of what replaced them (`sync_bases`), so it has it. A line changed alike on both is taken once; where both changed the same lines differently (or next to each other), the later's lines are kept.
  - **Terrain**: a face sculpted apart on two devices is merged cell by cell from the version both came from (kept the same way, deflated): each cell as the later sculpted it, if it did, and as the earlier did otherwise.
  - **Anything else** changed apart keeps the later, as before, and **what the earlier lost is kept as a conflict note** (`conflict`, conflicts.ts): a record on what it was about (the node, or the node a record or region belongs to) with the field, what it had and when; both devices make the same note (its id comes from what was lost), so it's one once they've synced. **Use this instead** puts it back (`conflict.use`, undoable); **Dismiss** removes it. They're listed under **Changed at once**, in the Share dialog and a world's Warnings. When a row was made and last changed aren't noted, nor a version of a field older than what its line knows (taken as one it was written on top of: no conflict is made up from a missing history).
  - **A record made apart with the same id** (a river's name and notes, a power system's age): the fields one device left at their defaults are stamped as never written, so the other's choices for them win, field by field, rather than the later record whole.
- **Undo per person**: each step on the undo stack keeps what it left in the fields it wrote (`Footprint`), and in terrain cell by cell; undoing or redoing it leaves a field (or cell) that holds something else by then (someone's change since) as it is and undoes the rest, and a step with nothing left to undo is taken off the stack and changes nothing. Since M21 this is in the store's write path (`step-store.ts`: the bus runs each step through it), so creates, deletes, restores and terrain are covered as well as patches; a deleted row counts as deleted whatever its time.
- **Off the main thread** (M21): the pages another device asks for are read by a worker (`sync.worker.ts`) through a read-only connection of its own (`PageReader`; WAL lets it read what's committed while the app writes), and what rows from another device come to is worked out there (`planMerge`) between what's read of this copy (`gatherMerge`: its version, its stamps and the versions of notes and terrain kept along its lines) and what's written (`applyMerge`, which works a row out again if it changed here meanwhile).
- **With other people** (M18): a universe shared with people on other tailnets, through Tailscale machine sharing (or on the same tailnet).
  - **Members**: the people a universe is shared with are records of the universe itself (`member`, packages/core/src/members.ts), by tailnet login, so every copy knows them. Inviting is `member.create` (the person inviting is listed too if they aren't yet, so the invitee's devices answer theirs), removing `member.delete`; only the user in the app changes them, never an API client or a plugin (the bus turns those down, in a batch too: `USER_ONLY_COMMANDS`, `checkSource`).
  - **Roles** (M20): a member is the **owner** (whoever first invites someone; one per universe), an **editor** or a **viewer**. Only the owner invites, removes and sets roles, and a viewer changes nothing: the app turns both down for the person signed in to Tailscale (`refusal`, in `Session`), and a device takes no rows from a viewer's devices and no member rows from anyone's but the owner's (`rowsFrom`; the user's own devices are trusted as the user is), so a member change reaches people from the owner's devices directly. Members from before roles are editors, and while a universe has no owner every editor manages members, as before; the first of them to invite someone becomes its owner.
  - **Who's answered**: the tailnet server answers another login on sync's questions (`/sync/…`) alone, and only while that login is a member of the universe open there, checked once for each request (`mayVisit`, on a set of the members' logins made again when they change), before its body is read; to anyone else hello says nothing is open, and the rest is turned away. The phone app, its bridge and signing in stay the owner's. A device asking another trusts what it says by the same rule (its owner is the user, or a member).
  - **Both ways from one side**: sharing a machine lets the person it's shared with reach it, but not it them, so a visitor to another person's device also gives what it got since it last gave (`POST /sync/push`, from `syncSent:<device>`, a page at a time, and nothing when nothing came since), merged by `sync.merge` like pulled rows (and shown in the window once a burst of pages is in); rows going both ways are only merged once. The user's own devices reach each other, so they only pull. Each device pulls and pushes only with its owner's devices and members' (by the login Tailscale gives each peer), whatever another claims to have open.
  - **What each answers**: a hello says what the device answers beyond the first questions (`can`: a visit in the hello, rows pushed to it), so a device knows how to greet another before asking; one from before saying it is found out by its 404s, as before.
  - **How often**: the user's own devices and members' are visited every round (10 s, 3 s while someone else is in); other people's, which may have a universe shared with you, at most every 10 s, and each time one has nothing to share (no answer, nothing open for you, or not a Universe) twice as long after, up to 80 s, until you look at your devices again (Connect AI, the start screen). After a change here, your own devices with it open are nudged to ask, and other people's are given it at once (without a new hello, as of their last exchange), but the one it came from. A device that turned down the newer hello (an older version) is greeted the older way for ten minutes.
  - **Shared with you**: another person's device whose hello has a universe open (so you're a member of it) is listed with its owner, and **Copy here** works as for your own devices.
  - **Who's in and where**: the window says where the user is (`setWhere`: "Terra, the map"); a hello (a POST now, GET still answered) carries the visitor's universe and where, and is answered with who's in it there: the device's own person and those it heard from in the last half minute, by how long ago (two clocks differ), so two people visiting a third see each other; no one's own entry goes back to them. Devices visit every 3 s while someone else is in, and visit at once those of other people with the universe open when the user moves.
  - **In the app**: **Share** (the top bar) invites people by their tailnet login and removes them, and lists who's in and where; a round mark for each person in now sits in the top bar (a click goes where they are) and on the tree row they're on; universes shared with you are listed under the device list, with **Copy here**.
- Not done (yet): a viewer's own copy can still be changed while it isn't signed in to Tailscale (nothing it changes is taken by the others); a member change made by the owner reaches others only from the owner's devices, not passed on by members'.

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
- [ ] Code signing (Windows certificate, Apple Developer ID). Deferred to M19, for when the certificates are in hand; builds are unsigned until then.
- [x] *Added after M2:* self-update. Each CI build is versioned `0.1.<run>` and publishes an `update.json` manifest (file names, sizes, SHA-512) with the installers. The app checks it at launch and hourly (and on request: Help → Change Version, or the **Change version** button on the start screen and in the status bar, which says right there when there’s nothing newer); a dismissable banner offers the new version, and **Upgrade now** downloads, verifies and installs it, then restarts, with no further input: NSIS installer run silently, portable exe swapped, macOS `.app` replaced from the zip, AppImage replaced in place. A `.deb` install needs the system password (root).
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
- [x] *Added after M3:* **characters** on a world: born and died dates (age at the playhead), and a journey of stops. Send one somewhere with 🧭 (they arrive at the playhead, setting out on foot early enough at 30 km a day) or to an event (a stop at its start and place); in between they walk the great circle. Shown at the playhead as figures on the globe and map and life-size on the ground. Deleting an event unlinks the stops that went to it. (Per-character timelines and relationships come in M14.)

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

### M8 — Phone access (1–2 weeks) — *done*
- [x] **OAuth for the API** (`packages/api` oauth.ts): metadata, dynamic client registration, a sign-in page that takes a code shown in the app, PKCE, access and rotating refresh tokens, revocation, connections removed one at a time. Nothing from the internet can crowd the user out: a full client list drops the oldest never-used registration, a new sign-in the oldest waiting one.
- [x] **Tailscale Funnel in Connect AI** (`src/main/tailscale.ts`): finds Tailscale (or says what's missing, or what Tailscale wants), turns Funnel on and off for the API's port and follows the port when it changes, shows the address to add on claude.ai; phone access on and off.
- [x] **Sign-in and connections in the app**: the code to type while a client signs in (shown even with Connect AI closed, and can be turned down), the list of connected clients and removing one.
- [x] Tests: the official MCP client through the whole OAuth flow (refresh and revocation included) in `packages/api`; `e2e/phone.spec.ts` plays claude.ai against the app through a stand-in Tailscale (`e2e/fake-tailscale.mjs`).
- [x] **Security audit** (five auditors: the API and OAuth, the Electron shell, untrusted data, the build and release, and a hands-on attack on phone access), every finding checked and the real ones fixed:
  - From the internet: a request Funnel forwards is from the internet whatever Host it names (it couldn't pass for this computer's, with the app's token, or get in with phone access off); clients registering from the internet may only be sent back to Claude, and the sign-in page and the app say where access goes; limits per sender; change feeds close once their client is disconnected; a refresh token used twice ends the connection.
  - The window: it only ever shows the app's own page (a note's link in a shared project could turn it into an attacker's page with the app's bridge), the main process answers only that page, the page loads only the app's own files (never another computer's: a network share on Windows), imported models only what's inside them; no device permissions or WebRTC; projects are checked before anything is written to them, and refused with triggers or views.
  - Data: nothing in a note, a date, a far-off time or a crafted project can stall the app (linear note reading, bounded dates, step-counted moon phases, inflation capped at a layer's size); the world bible escapes everything.
  - Build and release: read-only tokens unless publishing, one publish at a time, the updater takes only an installer's name from the manifest and stops a download that runs long; ci:local checks what it downloads and marks the commit it tested.
- Not yet tried against claude.ai itself and a real tailnet (the tests stand in for both).
- Deferred from the audit: signed update manifests and publishing installed copies' updates from `main` only (both done in M13); Electron fuses (asar integrity, no NODE_OPTIONS or inspect flags; RunAsNode stays for `--mcp`) with code signing in M19; validating every row of a project on load, the .deb installer's wait between checking and installing, and a nonce the stdio server checks before handing the app its token (all three done in M21).

### M9 — Power systems (1 week) — *done*
- [x] `power` and `powerAge` records, commands and templates in core (`powers.ts`): magic, divine, psionic, technology, political and other, each with its questions; an entry per system and era, merged as it's edited; era and system deletes take their entries.
- [x] **The Powers page** on a world (`PowersView.tsx`): systems from a template, what holds in every age, what's different in each era (a blank answer shows what always holds), how strong it is age by age, questions of its own, the playhead's age marked; right-click menus; it keeps still while you write in it.
- [x] API: `list_power_systems(worldId, at?)`, `create_power_system`, `update_power_system`, `describe_power_age` (answers by question, eras by name); powers in the world snapshot, the bible and `write_scene`.
- [x] Tests: core do/undo and reading at a moment, the operations and the bible, `e2e/powers.spec.ts`.

### M10 — Inconsistency detector (1 week) — *done*
- [x] Findings as records (`findings.ts`): a contradiction, something unlikely or a question, what it's about, why, a suggested fix, open, resolved or dismissed.
- [x] `report_inconsistency` (checks that what it's about is on the world; one already open or dismissed isn't reported twice), `list_inconsistencies`, `resolve_inconsistency`, and the `review_consistency` prompt (the world bible, the ids to refer to, the app's own checks and what's been reported). Findings are advice, so review mode lets them through.
- [x] **The Warnings page** on a world (`WarningsView.tsx`): a request to copy for Claude, its findings with what they're about (to open or right-click), resolve, dismiss and reopen, and the app's own checks (history, structures, food web); a count on the tab and amber marks in the tree, the timeline and the lists.
- [x] Tests: the operations and the prompt in `packages/api`, `e2e/warnings.spec.ts` with an MCP client reporting through the app.

### M11 — Phone app (2 weeks) — *done*
- [x] **The server** (`src/main/phone-app.ts`): the window's own built files and a bridge for the methods a phone may ask (`REMOTE_METHODS`: the open project's state, commands, undo, AI suggestions, terrain and assets; not files, dialogs, the API's settings or updates), with byte arrays carried in its JSON (`shared/wire.ts`) and the window's events as a stream. On 127.0.0.1, behind `tailscale serve` on port 8443 (the tailnet only, never Funnel), and only for requests carrying the tailnet owner's login.
- [x] **Sign-in**: the API's OAuth with the app as its own client; the phone types the code the computer shows, the app keeps the tokens and gives the phone a cookie (HttpOnly, Secure, SameSite=Strict, 90 days); it shows with the connected clients, and removing it ends its requests and its stream at once.
- [x] **On the phone** (`webBridge.ts`): the same app, one panel at a time with tabs below 700 px, a long press for the right-click menu, pinch to zoom the map (the globe and ground already turn and zoom by touch), and nothing that's only for the computer. A change on either shows on the other.
- [x] **On the home screen**: a web app manifest and icons (`src/renderer/public/`, made from the app icon by `build/make-web-icons.py`), served before sign-in since a browser fetches them without cookies; added to the home screen, it opens as an app of its own, full screen.
- [x] Tests: the server (who's turned away, the methods, paths, signing out) in `phone-app.test.ts`; `e2e/phone-app.spec.ts` with a phone-sized Electron window as the phone and the test playing `tailscale serve`.
- Not yet tried on a real phone and tailnet (the tests stand in for both). The phone gets the whole project state after each change; a large universe may want changes sent as differences.

### M12 — Sync (2–3 weeks) — *done*
- [x] **Stamps** (`packages/core/src/sync.ts`): a hybrid logical clock, a stamp on every row as its transaction commits, and the rows a device got since a given point; `sync.merge` keeps each row whose stamp is later, parents before children, logged but not undone with this device's changes.
- [x] **In the project file** (migration 6): each row's stamp and when this copy got it, stamped once for a project from before sync; a device id per install and a sync id per universe.
- [x] **Between devices** (`src/main/device-sync.ts`): the owner's other devices found in `tailscale status`, asked on the phone app's tailnet server (owner only, never a page), every 10 s and at once when nudged after a change; a universe open on another device copied here to a new file.
- [x] **In the app**: Sync with my other devices in Connect AI and on the start screen, each device with what it has open and when it last synced, and Copy here.
- [x] Tests: stamps, merges and three devices converging in `sync.test.ts` (core and db), the sync routes in `phone-app.test.ts`, and `e2e/sync.spec.ts` with two app instances on a stand-in tailnet copying a universe and syncing both ways.
- Row-level last-writer-wins only (see §6.7); not yet tried on two real computers.

### M13 — Polish & release (2 weeks) — *done*
- [x] **Right-click menus** on everything (`contextMenu.ts`): a node in the tree or a claimed one in the cosmos, an event, era, group, link, lane or theme span on the timeline or the canvas, a region, structure, character or event pin on the map, globe or ground, a species in the food web, a row in the inspector's lists. Each gives what its kind can do (open, rename, add to it, go to it, follow a link, move the playhead, delete); the keyboard opens and moves through it too.
- [x] **Change version** on the start screen and in the status bar (and Help → Change Version…), first added as Check for updates: Live, Staging and Dev, each with its newest build. This copy's own is checked for an update, and says right there when there's nothing newer; another is its own app (Universe (staging), Universe (dev)), installed beside this one and opened, the same way this copy is installed (an installer, a portable exe or AppImage next to this one, a .app beside it, a .deb). Each channel's Windows and Linux executable has its own name, so one's installer never closes another.
- [x] **Signed updates, released from main**: CI signs each update manifest with an Ed25519 key kept as the `UPDATE_SIGNING_KEY` secret (`scripts/sign-update.mjs`; `scripts/update-key.mjs` makes the pair once), and the app, which has the public half (`update-key.ts`), installs only what a manifest signed with it names (`update-signature.ts`); copies from before take one more update from the old, unsigned manifest. New work goes to `dev` (built, tested and published as `dev-build`), then `staging` (published as `staging-build`, to try by hand), then `main` (`latest-build`). *Added after M13:* dev's and staging's builds are apps of their own, **Universe (dev)** and **Universe (staging)** (their own name, app id, data folder and Linux package), that install beside Universe and update only from their own release.
- [x] **Eye-catching space** from star systems up (`spaceArt.ts`): skies with nebulae, dust and stars of every colour; a glowing cosmic web and clusters of gas and galaxies; galaxies with gold cores, blue arms and pink star-forming knots, gas clouds among the stars close up; a sun with a corona and turning rays, planets with a rim of air.
- [x] **A sample universe** to start from (`packages/api/src/sample.ts`): **Explore a sample universe** on the start screen (and in the Help menu) saves Calder, a world with fifteen centuries of history, where the user picks, and opens it on the world. Four eras, events linked and grouped, four regions, seven structures that weather and are fought over, three people, themes for its ages, a small food web and a magic system described age by age. It's written with the API's own operations (so it's checked like any edit), as the app's own changes (not the AI's), and opens with nothing to undo. Its places are all on land (tested against its seed). The API gained `create_era`. With nothing selected, the globe and the ground now open facing where a world's story is (the middle of its regions and structures), not 0°, 0°.
- [x] **Keyboard shortcuts** (`shortcuts.ts`): one table that both runs the keys and lists them in a sheet (`?`, or Help → Keyboard Shortcuts). `1`–`7` the world's views; letters for the tools (`H` navigate, `R` raise, `L` lower, `S` smooth, `F` flatten, `B` paint, `E` erase, `G` region, `P` place); on the timeline `N` a new event at the playhead, `[` and `]` the playhead to the event before or after (selected, so the views turn to it), `0` fit; and the menu's and the selection's keys. Single keys work while nothing that takes typing has focus and no dialog is open; what's on screen registers what its keys do, and buttons' tooltips say their key.
- [x] **Performance pass**, measured first (a world with hundreds of structures and thousands of events, frame times and draw calls while dragging each view and scrubbing): the map and the timeline stayed at 60 fps; the cost was structures on the ground and the globe's hit-testing. On the ground, structures now have a level of detail (in full while big on screen, about twenty times their size away; farther, plain blocks of their massing, all in one instanced mesh), and near ones that look alike (one blueprint, the same parts standing, weathered alike) draw together, one instanced mesh per kind of part: a town of 200 houses went from 279 draw calls a frame to 91. The globe finds the point under the pointer on the sphere (refined for the terrain) instead of against its 786,000 triangles: about 7 ms of every pointer move became 0.1 ms.
- Signed installers (Windows NSIS, macOS dmg + notarization) moved to M19 with Electron fuses, for when there's an Apple Developer ID and a Windows certificate; updates are already signature-checked (above).
- [x] **E2E tests for the main flows**: each part has its own (`e2e/*.spec.ts`, 34 tests on the dev build and the packaged apps, on Linux and Windows 10 and 11), and `main-flow.spec.ts` runs the whole of §10's flow at once: a world painted, a castle built, a siege that leads to its fall (which destroys it), an age of war over those years, and the views (the map, the inspector, the globe) at moments before and after.

### M14 — Factions & relationships (3 weeks) — *done*
- [x] **Factions** on a world (`packages/core/src/factions.ts`): kingdoms, empires, houses, clans, guilds, orders, faiths, companies and bands, each with a colour and an emblem, founded and dissolved (a year, or the events that did it), part of another if it is (a house in a kingdom), with members (characters, each with a role, joining and leaving) and territory (regions, held from one year to another; a kingdom holds what its houses hold). A **Factions page** on each world (7): the factions under the ones they're part of, dimmed while they don't exist at the playhead, and one faction's members, land and standing. On the globe and the map, **Territory** colours the regions by who holds them at the playhead, with a legend.
- [x] **Relationships** between characters and factions, or one of each: parent and child, spouse, sibling, kin, friends, allies, rivals, enemies, mentor and student, liege and vassal, or a label of one's own, each over a span. Read from either side ("Child", "Vassal") in each one's panel, and a **graph of who's related to whom** at the playhead (lines coloured by kind, dashes for who's in which faction).
- [x] **A lane of their own** on the timeline for any character or faction, from their panel: a character's life, the factions they belong to over it, the stops of their journey and the events they're in; a faction's span, its land and its events.
- [x] **Who took part**: events name characters and factions. What a faction did is said by its spans and the events that began and ended them (founded by a coronation, a region taken in a war, an alliance ended by a treaty), rather than by effects; the app flags a span that doesn't line up with its event.
- [x] **The API and MCP**: `list_factions` (at a moment, or their whole history), `get_relationships` (of one character or faction, read from their side), `create_faction`, `update_faction`, `add_member`, `hold_region`, `set_relationship`, and who took part in `create_event` and `update_event`. The snapshot, search and the world bible have them; `check_consistency` and the Warnings page run the app's own checks (a member before they're born or the faction's founded, a region held by two factions at once, allies who are enemies, a span off its cause), and the inconsistency prompt asks about the rest. Deleting a character or faction takes its memberships, holdings, relationships and part in events with it, undone together. Sync and the phone app carry them like every record.
- [x] The sample universe gains its factions: the Kingdom of Varn and House Aldric, the Greywood clans, the Lampwrights' Guild, a daughter for Aldric, and a war that ends in fealty.
- [x] Tests: commands, cascades and undo, who holds what and who's in what at a moment, relationships from either side, the checks (`factions.test.ts`); the API and the bible (`operations.test.ts`); `e2e/factions.spec.ts`: the sample's factions, a new one with a member and an enemy, the graph, a character's panel and lane, who took part, territory on the map, delete and undo.

- [x] *Added during M14:* **Universe (dev)** and **Universe (staging)**, builds of those branches as apps of their own, and **Change version** in place of Check for updates (see M13's items). The globe and the ground fill their box when they open during the zoom between levels.
- [x] *Added during M14:* **spelling**. Misspelled words are underlined as they're typed, in every text field and the notes editor, by the app's own dictionary (English, Hunspell's, through nspell, bundled: the same everywhere, nothing downloaded; `main/dictionary.ts`). Right-clicking text gives the word's corrections (closest first, a swap of two letters counting as one change), **Add to the dictionary**, and cut, copy, paste and select all. The user's own words are kept in their profile (Edit → Dictionary… lists them, to add to or take out); the names of everything in the open universe count as words already.
- [x] *Added during M14:* **walking the ground**. On the ground, W A S D (or the arrow keys) move over it the way the camera faces, at the speed picked in the toolbar (Walk 300 m/s, Run 1 km/s, Ride 3 km/s, Fly 12.5 km/s), Shift for three times as fast.
- [x] *Added during M14:* **universal power systems** (§4.6): the universe's, pinned to planets, star systems, galaxies or eras, listed on any place's inspector; older projects' systems move into the universe pinned to their world (schema 7); `pin_power_system` in the API.
- [x] *Added during M16:* **sub-factions, as deep as they go**: a faction's page lists its parts and starts a new one (**+ Sub-faction**, or **Add a sub-faction** from its right-click menu), each with parts of its own; the list nests them all; a faction that goes hands its parts up to what it was part of.
- [x] *Added during M14:* **one zoom, universe to ground**: the wheel alone goes down through every level (into what's under the cursor, or the nearest thing, claiming on the way in what the seed made) to the globe and the ground, and back up; the map scrolls out to the planet too, and the globe and ground zoom in about fifteen notches.
- [x] *Added during M14:* **the ground reaches 12 km**, the chunks' 5 km and a coarse sheet beyond (built in a worker); the planet's map in the corner, a fiftieth of it centred on the camera, shows where you are and an arrow the way you face, and a click on it goes there.
- [x] *Added during M14:* **middle-drag to resize**: on the globe, map or ground, the terrain brush while a terrain tool is out, else the selected structure. Every planet setting says what it does on hover.

### M15 — Rivers & erosion (3 weeks) — *done*
- [x] **Rivers and lakes** from the terrain (`packages/procgen/src/hydrology.ts`): every cell drains to the sea, the basins it can't leave filled from the sea up (priority flood); water gathers downhill from the rain on each cell, more where it's wet, and where enough has gathered it's a river, traced from source to mouth with its tributaries, each named from the seed and known by where it ends (`r<cell>`), so its id stays while the land upstream changes. A deep basin holds a lake (`l<deepest cell>`) as big as the water reaching it keeps up: full and spilling over if there's plenty, else smaller, with no outlet. About half a second for a whole planet, in a worker; worked out again once a stroke is saved, an edit undone or the sea moved.
- [x] **On every view**: rivers on the map and the globe, wider as more water runs in them and curving through the cells they cross (so tributaries meet them), lakes coloured as water; on the ground, each river a ribbon over the land as wide as its water, each lake a sheet at its surface, out to as far as the ground goes.
- [x] **Named and selectable like regions**: the world's inspector lists its rivers and lakes, the biggest first; a click there, on the map or in a right-click menu opens one, to give it a name of its own (or back the one it was made with) and notes, kept in a waterway record by its id (`packages/core/src/waterways.ts`, `waterway.set` through the bus, undoable), with its length and where it runs or its area and surface, what feeds it, and **View up close** down to the ground there.
- [x] **Erosion over time** (`packages/procgen/src/erosion.ts`): how deep each cell wears down in the long run, rivers cutting valleys by their water and slope (their valley sides with them) and steep slopes slumping, never at sea, under a lake or where the user has sculpted (terrain edits win), land staying land; how much of it has happened depends only on the years since the timeline began and the world's erosion speed (two-thirds in about 4,000 years at 1×), so it's the same every time, shown as the playhead moves in thirty-two steps. Rivers are worked out from the land before wear, so they stay put.
- [x] **The API and MCP**: `list_waterways`, `get_waterway` (with a river's course) and `name_waterway`, worked out as the app does (in the app's terrain worker), so with the same ids and names; the world bible tells of the greatest rivers and lakes and every named one. Sync carries waterway records like every record.
- [x] Tests: hydrology (neighbours across the cube's edges, water reaching the sea, a lake in a bowl, rivers into lakes and rivers, the same every time), erosion (valleys along a river, nothing at sea, under lakes or where sculpted, the pace) and the terrain model worn and back; waterway records, commands and undo; the operations and the bible; `e2e/water.spec.ts`: listed, opened, renamed, undone, named from the menu, picked on the map, seen up close, named by an AI, worked out again when the sea rises and worn down thousands of years on.
- Plate tectonics later, if ever: continents drifting over millions of years.

### M16 — Plugins (3 weeks) — *done*
- [x] **Plugins as local folders** (`packages/plugins`): `plugin.json` says what a plugin offers (generators, exporters and name generators, each with the options it asks for, checked) and `main.js`, an ES module, does it; a plugin imports only its own files. The app finds them in its own plugins folder and in folders of the user's it's pointed to (`main/plugins.ts`).
- [x] **Sandboxed**: a plugin's code runs in QuickJS, a JavaScript engine of its own compiled to WebAssembly, in a worker of its own for each run, and reaches nothing (no network, no files, no Node, no page) but `universe`: the API's operations (the same table as MCP and REST), a text file the user picks, a PNG encoder, a log and seeded random numbers. Each run is stopped past 120 s, 256 MB, 20,000 calls or 10,000 changes.
- [x] **Through the command bus, undoable as one**: a generator's changes are made through the API's operations as the plugin's, each applied as it goes (so the plugin reads what it made), and become one step to undo and redo when it's done (`CommandBus.group`); if it fails part way, they're taken back. Exporters and name generators can read everything and change nothing. An exporter's files are saved only where the user says (a folder for several, never outside it).
- [x] **Generators** run on a world or the universe, from the plugin manager or a world's inspector, with their options as a form; **exporters** take a world out to files; **name generators** name characters, factions, regions, structures, nodes, species and events from their right-click menus (**Name it…**), the name picked from a list. New operations for them, and AI clients: `get_terrain_at` (what the land is like at places) and `get_world_map` (the map's colours).
- [x] **A plugin manager** (Tools → Plugins…): each plugin turned on or off, its folder shown, removed (a folder of the user's is only forgotten), its errors and its last run's log; a new plugin from **the template**, a working example (villages on dry land, names in three styles, a wiki and a map image) with **how to write one** in its README (`apps/desktop/plugin-template`).
- [x] Tests: the sandbox (operations, names from a seed, files and bytes, imports, nothing of the computer in reach, every limit, manifests) (`sandbox.test.ts`); grouping changes (`bus.test.ts`); the terrain and map operations; the PNG encoder; `e2e/plugins.spec.ts`: the template's villages made and undone as one, its wiki and map saved, a world named, and a plugin that fails part way leaving nothing behind.
- [x] *Added during M16:* **sub-factions, as deep as they go** (see M14).

### M17 — The canvas, as Obsidian has it (2–3 weeks) — *done*
A world's canvas does everything Obsidian's Canvas does, with the world's events on it as now:
- [x] **Cards of its own** beside the events, added from the toolbar, a right-click or a double-click on empty board: **text** (Markdown, written in place), **an element of the project** (a character, faction, region, structure, species, river or place, its name, kind and notes, opened with a click), **a picture** (from a file, kept in the project) and **a web link** (opened in the browser with a click; the app itself stays offline, so there's no page inside it). Pictures are dropped or pasted in too; new cards find a free place.
- [x] **Groups**: a labelled, coloured box, made empty or round the selection; what's inside moves with it.
- [x] **Connections** between any two cards, from and to any side: a label, a colour, an arrow at the end, both ends or neither; dragged off into empty board, one makes a new card there. Between two events it's a timeline link as before (cause, effect…).
- [x] **Every card** (and event) resized by its corner and coloured (six colours or any); selected by a click, Shift-click or a box dragged round them; moved, aligned, duplicated, copied and pasted, and deleted together; a text card turned into an event.
- [x] **The board**: zoom in and out, to fit, to the selection and to 100%; snap to the grid and to other cards' edges (with guides); read-only; export as a PNG image. Its tools are in the canvas's toolbar, so nothing covers the board; it opens fitted and stays put. A click selects an event and a double-click goes to it.
- [x] **Through the command bus** (`packages/core/src/canvas.ts`: card and connection records, undoable, synced like every record; a card's or event's connections go with it); the API and MCP: `get_canvas`, `add_canvas_card`, `update_canvas_card` and `connect_on_canvas`; the world bible has the text cards under their first lines.
- [x] Tests: the records and commands (`canvas.test.ts`); the geometry and the Markdown (`world/canvas/*.test.ts`); the operations and the bible; `e2e/canvas.spec.ts`: every kind of card, connections, selection, groups, colours, resizing, duplicating, the board's tools, export and a card turned into an event.

### M18 — Live collaboration (4–6 weeks) — *done*
- Several people editing one universe at once over their tailnets: invite someone (Tailscale sharing), see who's in and where, changes appearing as they're made.
- A real merge story beyond M12's row-level last-writer-wins: field-level merges (or CRDTs) so two people editing one event don't lose each other's work, and per-person undo.
- [x] **Members** (`packages/core/src/members.ts`): the people a universe is shared with, by tailnet login, records of the universe that sync with it; `member.create` (the inviter listed too), `member.update`, `member.delete`; `list_universe_members` in the API, which can't change them.
- [x] **Tailscale**: who's signed in, and other people's devices this computer can reach (on the tailnet or shared into it), each with its owner; not tagged servers, nor devices only there because this one is shared with them.
- [x] **Sync with other people** (`device-sync.ts`, `phone-app.ts`; §6.7): members' devices answered on sync's four questions alone; a visitor pushes its changes (`/sync/push`); members' devices visited, pulled from and pushed to like the owner's; universes shared with you listed with their owners, and copied here.
- [x] **Who's in and where** (`presence.ts`): hellos carry where each person is and pass on who's in, for half a minute; every 3 s while someone else is in.
- [x] **The window's contract** (`src/shared/api.ts`, `Collaboration`): `collaboration()`, `onCollaboration`, `setWhere`, `copyFromDevice` for shared devices, and inviting and removing as commands.
- [x] **In the app** (`components/Share.tsx`, `collaboration.ts`, `people.ts`): **Share** in the top bar invites people by tailnet login (those Tailscale knows offered in a click), says what they need (your tailnet, or this computer shared with them; Tailscale's machines page opens in the browser), lists who it's shared with, who's in now and where, and removes them (right-click too), and offers to turn sync on while it's off; a round mark for each person in now in the top bar ("bea, on Sol", a click goes there) and on the tree row they're on, redrawn only when who's in changes; where the user is told to main as the selection or view changes; universes shared with you, with their owners, under the device list (Connect AI and the start screen), each with **Copy here**.
- [x] **Merging per field** and **per-person undo** (`fields.ts`, `field-stamps.ts`, `sync-commands.ts`, `command-kit.ts`; §6.7): stamps per field (migration 8), merges field by field, and undo that leaves a field someone has changed since.
- [x] Tests: members (core), the API's refusal, Tailscale's shared and sharee peers, the sync routes for the owner, a member and a stranger, a pushed page, two people sharing both ways, removing someone, three people passing on where they are, and a device claiming a universe it isn't shared (`device-sync.test.ts`, `presence.test.ts`, `phone-app.test.ts`); where someone is in words, their marks and who's on each node (`people.test.ts`). The e2e stand-in Tailscale can be another login with other people's devices; `e2e/collaboration.spec.ts`: two people on two computers, one inviting the other from the Share dialog (sync turned on there), the other copying it from Shared with you, each seeing the other in and where (the top bar, the tree, the list of people, a click going there), both changing different fields of one event at once and both changes ending up on both, and the one removed no longer answered.

### M19 — Signed installers (1 week, when the certificates are in hand) — *in progress*
- [x] **Signing, ready for the certificates** (`electron-builder.cjs`, `build.yml`): Windows' installer and portable exe signed through Azure Artifact Signing (formerly Trusted Signing: about $10 a month, works from CI without a hardware token; EV certificates no longer skip SmartScreen's reputation since 2024), macOS's dmg and zip with a Developer ID and notarized; the secrets reach `main`'s and `staging`'s builds alone, and each system's builds stay as they were (unsigned, or ad-hoc on macOS) until its secrets are added. The secrets and how to get them are in the README.
- [x] **Electron fuses**: the app's code is only what's in its archive, checked against the hash the binary carries (macOS and Windows), and NODE_OPTIONS can't change how it runs. RunAsNode stays (`--mcp` serves stdio that way), and so do the inspect switches: the packaged app's end-to-end tests drive it through them.
- [ ] The certificates: an Azure Artifact Signing account and certificate profile (individuals in the US and Canada; organizations in more places), and an Apple Developer ID, as repository secrets. SmartScreen then learns the signed builds' reputation as they're downloaded; the install script below stays for the meantime.
- [x] **The Microsoft Store** (in place of a certificate for Windows, for now): `main`'s builds package Universe as MSIX (`Universe-…-store.appx`; build.yml's store job, on every branch to check it), which the Store signs, so a copy installed from the Store is never warned about by Windows or the browser. Its identity comes from Partner Center as repository variables (`STORE_IDENTITY_NAME`, `STORE_PUBLISHER`, `STORE_PUBLISHER_NAME`; stand-ins until then); the package has a `universe` command (an app execution alias), which Connect AI's Claude Code command uses from a Store copy; a Store copy leaves updates to the Store. The owner's step: registering in Partner Center (free for individuals) and submitting (README).
- [x] *Meanwhile:* a PowerShell install script (`scripts/install.ps1`, published with each release) downloads the Windows installer itself, so it carries no mark of the web and neither the browser nor SmartScreen stops it, and checks it against the release's update manifest before running it.

### M20 — Collaboration, part two (2–3 weeks) — *in progress*
- What M18 left for later (§6.7): the losing version of a conflict kept as a note; notes merged line by line rather than whole; a record two devices first create apart with the same id (a world's timeline settings, a star) merged rather than the later one kept; a sculpt on one face of terrain merged cell by cell with another's.
- Per-person permissions: members who can only look, and only the universe's owner able to change who it's shared with (today every member is trusted alike).
- Tried on two real tailnets, with a machine shared between two people (so far only the stand-in Tailscale has run it); what each device can answer said in its hello, rather than an older version found by its 404s.
- [x] **Lineage** (`lineage.ts`, `field-stamps.ts`, `sync.ts`; migration 9): what each field was written over, kept and sent with its stamps, telling changes made on top of another from those made apart; the versions of notes and terrain written over kept to merge with (`sync_bases`).
- [x] **Notes merged line by line** and **terrain cell by cell** (`line-merge.ts`, `sync-commands.ts`), from the version both came from.
- [x] **Conflict notes** (`conflicts.ts`, `conflict-commands.ts`, `components/Conflicts.tsx`): what a change made apart lost, the same note on every device, under **Changed at once** in the Share dialog and a world's Warnings (counted on its tab), put back with `conflict.use` (undoable) or dismissed.
- [x] **A record made apart with the same id** merged field by field, the defaults one side left losing to the other's choices (`upsert`, `SyncLedger.unset`).
- [x] **Roles** (`members.ts`, `member-commands.ts`, `session.ts`, `device-sync.ts`, `Share.tsx`): an owner, editors and viewers; only the owner changes who it's shared with, a viewer changes nothing (refused in the app, their rows not taken); chosen when inviting and changed in the Share dialog; a **View only** mark for viewers.
- [x] **What each device answers** said in its hello (`can`).
- [x] Tests: lineage, line and cell merges (`line-merge.test.ts`); changes made apart on two and three devices, notes, terrain, a record made apart, conflict notes put back, undone and dismissed, and a device from before lineage (`sync.test.ts`); lineage and kept versions across closing the file (db `sync.test.ts`); roles and `rowsFrom` (`members.test.ts`); a viewer's and an editor's rows, and the hello's `can` (`device-sync.test.ts`); `e2e/collaboration.spec.ts`: a viewer turned down, made an editor, and a title both renamed at once put back from its conflict note.
- [ ] Tried on two real tailnets, with a machine shared between two people: the owner's step (only the stand-in Tailscale has run it so far).

### M21 — Sturdier underneath (2 weeks) — *done*
- From the reviews: per-person undo moved into the store's write path, so creates, deletes, restores and terrain are covered too; a world's settings a row of their own from the start (no stand-in stamp for settings never set); merging and paging rows off the main thread; one stack for dialogs and menus, so Escape and what's in front follow the order they opened in.
- The canvas: its drag handling in a hook of its own, connections picked above the cards they pass under, and Export as image drawn from the board's data rather than captured from the window.
- From the audit: every row of a project checked as it loads; the .deb installer's wait between checking and installing; a nonce the stdio server checks before handing the app its token.
- [x] **Per-person undo in the write path** (`step-store.ts`, `footprint.ts`): every write a step makes notes what it left, field by field and terrain cell by cell; undone or redone, what someone changed since stays (§6.7). `patchRow` and `world.update` just write, and undo what was written.
- [x] **A world's settings are a row from the start**: written with the world (its defaults), and for older projects made rows (migration 10) and stamped as they open.
- [x] **Sync off the main thread** (`sync.worker.ts`, `PageReader`, `gatherMerge`/`planMerge`/`applyMerge`; §6.7); the main process's workers share one way of calling them (`worker-calls.ts`).
- [x] **One stack for dialogs and menus** (`layers.ts`): the latest open is in front and the one Escape closes, wherever the focus is.
- [x] **The canvas**: its drags in a hook of their own (`useBoardDrag.ts`); lines picked above the cards (a layer of their own), but near their ends, where the handles are (`pickedPart`); Export as image drawn from the board's data (`drawBoard.ts`), the whole board at twice its size, saved by main as the PNG it's handed.
- [x] **Every row checked as it's read** (`sqlite-store.ts`): one that isn't valid is left out (the window says how many), and one from an older version gets the defaults of what's been added since.
- [x] **A .deb update installed from root's own copy**, checked again there (`deb-install.ts`), so it can't be swapped while the password is asked for.
- [x] **The stdio server hands over the token only to the app**: whatever answers at the app's port proves it knows the token first (an HMAC of a nonce, `/v1/prove`).
- [x] Tests: undoing creates, deletes and terrain per person, a merge worked out apart and a row changed meanwhile (`sync.test.ts`); pages through a reader of their own and a merge with the work done apart, worlds' settings rows, rows checked as they're read (db); a stand-in at the app's port never handed the token (`servers.test.ts`); the .deb script with a stand-in `dpkg`, and a file changed after it was checked (`deb-install.test.ts`); picking lines (`board.test.ts`); a menu over a dialog, in front and closed first (`e2e/spelling.spec.ts`); a click on a line, and the exported picture's size (`e2e/canvas.spec.ts`).

### M22 — The ground, beautiful (2 weeks) — *done*
- Asked for: the surface up close made smooth and beautiful, with the sky and clouds, natural wadis, ravines and waterfalls, and the distance not just fog.
- [x] **The sky** (`groundSky.tsx`): a dome around the camera, deep overhead and pale at the horizon, the sun and its glow, and clouds that drift on the wind (a few frames a second while the view is just looked at), their shadows on the land and the plants (`groundAir.ts`); all in the theme's colours. The view looks out level, and up at the sky, close to the ground (`EYE_M`, `LOOK_UP`), and moves smoothly (damped).
- [x] **To the horizon, not into fog**: the land goes on past the distant ground in rings to 160 km (`buildHorizonGround`, built again every 8 km), and the sea to the horizon; everything curves down with the planet (so the sea has a horizon and far land sinks behind it), and the air hazes it exponentially, like real air, into the horizon's colour (`HAZE_M`): mountains 50 km off still show, paler. Depth is logarithmic so far hills still hide the ones behind (`deep` canvases).
- [x] **Land shaped by water and weather** (`GroundDetail`): wadis in dry land (flat gravel floors between steep banks), ravines in rough, high land (deep, V-shaped, rock walls), side gullies, mesas and ledges stepping dry and rough slopes; rock where it's too steep for soil (sandstone in dry land), snow where it can lie, drier grass and bare earth among the green; fine grain up close (`grain`); 16 m vertices, and normals worked out from the heights on both sides of a chunk's edge, so chunks shade without seams.
- [x] **Rivers, lakes and waterfalls** (`ground-water.ts`, `groundWater.tsx`): a river's course worked out from the globe's, its water's surface below the land it cut, stepping down in falls where the land is steep (`FALL_M`), the same stretch the same whichever view it's for; valleys cut to hold rivers, lakes in basins with raised shores; falls drawn as curtains of white water with foam and spray below; water that ripples, reflects the sky (more at a glancing angle) and glints in the sun. What stands on water stands on its surface.
- [x] **The minimap shows the land around** (asked for after): some 500 km² (32 by 16 km) of the ground itself, drawn from above in a worker (`buildGroundMap`, `ground-map.worker.ts`): its colours, hills shaded from the north-west, the sea, rivers and lakes; it slides under the arrow as the view moves and is drawn again each kilometre; a click goes to the spot clicked. The hills too small to show between points (`spacing`) are left out of it and of the distant ground.
- [x] Tests: falls in steep land and none in gentle, water that never runs uphill, the same course for neighbouring views, valleys, lake basins and shores, the same heights for the view as for the chunks (`ground-water.test.ts`); chunks shading alike along an edge, wadis deeper in dry land, the horizon's reach (`ground.test.ts`); `e2e/walk.spec.ts`: down to the eye's height, and the land to the horizon under the sky.

### M23 — Rough country (1 week) — *done*
- Asked for: rough terrain, sudden cliffs dropping a few feet, hills, extreme hills, large mountains, denser treelines, land that never looks flat; and Space, flying, rising without tipping the view down.
- [x] **The kinds of land** (`GroundDetail.landform`): over tens of kilometres, plains, hill country, extreme hills (steep, close together) and mountains (ridged peaks hundreds of metres to over a kilometre over their valleys, winding ranges; more where the globe has the land high); even plains swell and dip some 25 m. Land the globe has above the sea stays above it.
- [x] **Rough ground and cliffs** (`cliffs`): bumps and hollows of a metre or more everywhere, more in rough land; in patches of country, the ground drops suddenly a metre or two (a few feet in the plains), and in rough land by scarps of tens of metres. Chunks' vertices 10 m apart (96 a side), so a cliff is a cliff; chunks built two at a time (`workerPool`).
- [x] **Denser woods**: forests nearly twice as thick, more of the far chunks' trees drawn, and the woods' canopy raised and darkened on the distant ground and to the horizon, so far forests look like forests; mountains show on the horizon (what shows is chosen by how far apart the points are, `spacing`).
- [x] **Rivers in rough land**: levees where the land around lies lower than their water, and valleys whose sides steepen to meet the mountains.
- [x] **Space keeps the view's direction** (`walk.tsx`): rising, what the view looks at moves on ahead along the line of sight (up to 8 km), so only the height changes; the view can be pulled back that far again.
- [x] Tests: plains never flat and never under the sea, mountains where the land is high, cliffs (`ground.test.ts`); `e2e/walk.spec.ts`: Space rising and still looking the same way.

### M24 — Languages (1 week) — *done*
- Asked for: naming rules for rivers, species, factions and planets, configurable to follow the languages of planets and regions.
- [x] **Languages** (`languages.ts`, `language-commands.ts`): records in the project's library, each with its sounds (consonants, vowels, syllable shapes, how many syllables a word has, the endings it likes) and a naming rule for each kind of thing it names (rivers, lakes, species, factions, and planets, moons, stars and galaxies): a pattern with {name}, as "{name} River", "Wadi {name}" or "House {name}" ({kind} for a faction's kind). Five presets to start from (Common, Elvish, Dwarvish, Desert, Northern). A word for a thing is the same every time (from its id), made of the language's sounds alone.
- [x] **Where they're spoken** (`languageUse`): by any node (a world, a planet, a star system, a galaxy…) and all it holds, unless something in it speaks its own, and by a region of a world; the one in force is the region's, else the nearest node's up the tree (`languageAt`). One a place; deleting a language takes its uses with it; all through the bus, undoable and synced like every record.
- [x] **Names that follow them**: rivers and lakes are named in the language where they run (a river at its middle, a lake at its deepest; `namedWater`), in the app and the API alike, until given names of their own; new planets, moons, stars and galaxies in the language where they're added, new species and factions in their world's ("New …" where none is spoken); and **Name it in …** in the right-click menu of a node, a species, a faction, a river or a lake gives it a new name in its place's language.
- [x] **The panels**: Language in every node's inspector (what's spoken here, as around it or its own, names it gives, the library and a new language from a preset, spoken here at once) and in a region's; a language's own panel (its sounds, word length, endings, rules with names each gives, notes).
- [x] **For AI clients**: `list_languages`, `add_language`, `update_language`, `speak_language` and `name_in_language`.
- [x] Tests: words the same each time and made of the language's sounds, rules, the language in force (a region's, a node's, up the tree), one a place, deleting and undoing (`languages.test.ts`); a world's rivers named by its language through the API and back again (`operations.test.ts`); `e2e/languages.spec.ts`: a world speaking Desert (its rivers, a rule changed, a new faction) and a star system speaking Elvish (a new planet).

### M25 — Scarred land (1 week) — *done*
- Asked for: another overhaul of the land, with the ability to change it: explosions, irradiated areas, war, drought, poisoned soil and the like.
- [x] **Scars** (`scars.ts`, `scar-commands.ts`): records of a world's own, each a kind — a crater, war-torn, burned, drought, irradiated or poisoned land — at a point reaching some kilometres around it, or over a region; it comes at a time, is at its worst until its end (a blast and a fire are over in a moment, a war or a drought lasts until it's given an end, or for good), then heals over years (`scarWeight`; a crater never does unless told). How bad it is (0–100%), its name, notes and the event that made it. Through the bus, undoable and synced like every record; deleting its event leaves it, unlinked.
- [x] **The land they change** (procgen `scars.ts`, `ScarShaper`): a crater's bowl a fifth as deep as it is wide (to 1.5 km) with a raised rim and paler thrown-out earth around it; war pocks the ground with shell holes a few metres across up close; the ground turns ashen, churned mud, black, parched, sickly yellow or purplish, patchy and with frayed edges; plants die (most under fire, poison and radiation, fewer in a drought), trees left as bare trunks; the distant woods thin out too. The same in the ground's chunks, the distant ground, the horizon and the minimap (built in their workers from the same list), and in the heights things stand on. On the globe and the map, the cells they cover are lowered (great craters) and coloured (`scarField`, on the terrain model like erosion), and each scar has a ring in its colour and its icon, picked with a click.
- [x] **What they do to what's built**: as a crater, war or fire comes, it damages the structures where it reaches (a crater destroys those at its heart), in the condition engine like an event's effects.
- [x] **Made in the app**: the 💥 tool (X) leaves the chosen kind of scar, of the chosen size (100 m to 2,000 km), where the surface is clicked, at the playhead; **Leave a scar here** in the surface's right-click menu; an event's panel lists the scars it left and leaves one more, over its place, from its start to its end. A scar's panel: its kind, name, place or region, reach, when it comes, its worst until, healing, how bad, its event, notes, and how much of it there is at the playhead; the world's list of them; the ground opens over a selected one.
- [x] **For AI clients**: `list_scars` (with how much of each is left at a date), `add_scar` and `update_scar`.
- [x] Tests: made as their kind has them, undone, kept when their event goes, their weight over time, a crater destroying what's at its heart and damaging what's near its edge (`scars.test.ts` in core); a crater's bowl and rim, shell holes up close and not from afar, fire killing the woods and darkening the ground, drought parching it, a region scarred inside only, the globe's cells lowered and coloured (`scars.test.ts` in procgen); the operations (`operations.test.ts`); `e2e/scars.spec.ts`: a drought left with the tool parching the map and healing after its end, a crater from the menu, seen up close on the ground.

### M26 — Space, beautiful (1 week) — *done*
- Asked for: another beauty update: the lines like constellations taken off the universe and constellations put in the galaxies, galaxies more beautiful (no yellow splash), nebulae, supernovae and the like, and nothing in space ever drawn over anything else, at every level but a planet's surface.
- [x] **No web of lines**: the universe shows its clusters strung along the cosmic web, without the lines between them.
- [x] **Galaxies painted from their shape** (`galaxyGlowPixels`, in a worker): a spiral's warm core, sharp blue arms with dark dust lanes along their inner edges (`dustField`) and pink knots where stars are born, a barred spiral's bar; ellipticals bright in the middle and fading smoothly to nothing; irregulars patchy with soft edges; a sparkle of single stars over each, thinning toward the edge. Inside a galaxy, no haze over its middle: dim red dwarfs faint and bright giants full.
- [x] **Nebulae and the rest** (`galaxyFeatures`, `galaxyFeatureSprite`): glowing red nebulae with teal hearts, blue reflection nebulae, dark dust clouds, supernova remnants (torn shells of red and blue filaments round a pulsar), planetary nebulae (rings round a white dwarf) and young blue clusters, sized to the galaxy, along a disc's arms (an elliptical has only old ones).
- [x] **Constellations** (`galaxyConstellations`): nine or so in each galaxy, each joining four to seven of its bright stars by their shortest lines, named, the lines stopping short of each star; clearest from afar.
- [x] **Nothing over anything else** (`declutter.ts`): a universe's clusters and a cluster's galaxies are spread apart where they're made (`spreadApart`), and at every zoom what's drawn is kept clear on screen: shrunk to the room there is, your own things nudged clear, a crowded generated speck left out; in the star-system and planet views, planets and moons are kept clear of each other and of the sun however close their orbits bring them; labels never cover each other.
- [x] Tests: clusters and galaxies never overlapping as drawn, constellations (each star in one, joined without loops), nebulae and dust lanes, ellipticals with only old things (`cosmos.test.ts`); declutter shrinking, nudging and leaving out, and labels (`declutter.test.ts`); `e2e/cosmos.spec.ts` and `e2e/sky.spec.ts`: no overlaps at the universe, a cluster, a galaxy, close in, a star system and a planet, and a galaxy's constellations.

### M27 — One zoom through space (1 week) — *done*
- Asked for: a planet and its surface the same thing, not separate layers in the tree, with moons under their planet; and seamless transitions in and out between the levels of space.
- [x] **A planet is its surface**: in the tree a planet or moon with a surface is one row (🌍), which opens the surface; its moons are under it. The breadcrumb, the timeline and the inspector go by the planet's name; the inspector shows the surface's settings with the planet's orbit and spin, adds moons to the planet, and deletes the planet (Delete too). Renaming renames both, and a new surface takes its planet's name (also when claimed, or made by `create_world`). Its orbit with the moons round it is one zoom out from the globe ("Planet view").
- [x] **One camera through the levels** (`ZoomStage`): going in, the old level grows until what was gone into fills the screen while the new one comes in from that very spot and size; going out, the old level shrinks into where the level above draws it (each view says where it drew things, `noteDrawn`), as that level comes in zoomed in on it. The scale grows exponentially, the smaller level has soft edges, and the old one fades as the new one fills the screen; from the universe down to the globe and back.
- [x] **Values explain themselves** (asked for after): resting the pointer on a value for a second says what it changes, in a bubble beside it (`Hint.tsx`, `data-hint`): a star's mass and brightness; a planet's or moon's distance, eccentricity, day, axial tilt, inclination, start angle, mass and size; every world-generation option; a scar's kind, reach, timing, healing and strength; a structure's blueprint, date, rotation and size; an event's, era's and link's dates, precision, lane and colours; a theme's colours, lighting, haze and type and its spans' timing, place and priority; characters' lives; regions' coming and going; seeds; and the world tools' sizes, strength and relief.
- [x] Tests: `e2e/zoom-levels.spec.ts` (the wheel from the universe to the ground and back), the tree's one row per planet throughout the e2e suite (`orbitOf` for a planet's orbit view); `e2e/sky.spec.ts`: inclination's explanation shows after a second, not at once, and goes when the pointer leaves.

### M28 — Worlds up close (3 weeks) — *planned*
- Deferred from M1: dragging a region's corners to reshape it, lighting without seams across the globe's face edges, and finer terrain close up (a quadtree of detail where the camera is).

**Where things stand (12 Oct 2026):** M0–M18 are done and live (0.1.87 has live collaboration). M19 is live (0.1.90) in all that doesn't need certificates: the fuses, and signing ready to switch on; its last step is the certificates, as repository secrets. M20 is built on `dev` (conflict notes, notes merged line by line and terrain cell by cell, roles, what each device answers); its last step is trying it on two real tailnets. Also on `dev`, asked for along the way: **pins** on a world's surface (right-click any point of the globe, the map or the ground, **Add a pin here**, and name it; `mapPin` records with a colour and notes, and `list_map_pins`, `add_map_pin` and `update_map_pin` for AI clients; `e2e/map-pins.spec.ts`), and a globe that **turns less the closer the camera is to the ground** (`turnSpeed`). M21 is built on `dev` too (sturdier underneath: per-person undo for every write, sync's work off the main thread, rows checked as they load, one stack for dialogs and menus, the canvas's drags, lines and exported pictures, and the audit's three: the stdio token, the .deb wait, bad rows). So is M22 (13 Oct): the ground up close with its sky and drifting clouds, land and sea to the horizon in a haze rather than fog, wadis, ravines, ledges and snow, rivers in valleys with waterfalls, and lakes in basins. Then, asked for (14 Oct), **M23**: rough country (mountains, extreme hills, plains that swell, rough ground, cliffs, denser woods, and Space rising without tipping the view), and **M24**: languages (how names sound and the rules for rivers, lakes, species, factions and planets, spoken by nodes and regions). Then, asked for, **M25**: scarred land (craters, war, fire, drought, radiation and poison, at a time and healing over years, on every view and damaging what's built). Then, asked for, **M26**: space, beautiful (galaxies painted from their shapes with nebulae, supernova remnants and named constellations, no web of lines, and nothing in space drawn over anything else). Then, asked for, **M27**: one zoom through space (a planet and its surface one row in the tree, moons under it, and the levels zooming into each other as one camera). M28 is what's next.

**Rough total: 19–25 weeks** to v1 (M0–M13); M14–M19 are after it. for one full-time developer. M7 (API/MCP) can be pulled earlier, right after M2, if AI assistance is wanted sooner. The core layer makes it cheap to add.

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
| A public address for the API (phone access) | Off by default; only through Funnel to 127.0.0.1; OAuth with a code only the app's screen shows; tokens hashed, short-lived and revocable per device; Origin and Host checks kept. |
| Electron bundle size | Acceptable for v1. Tauri migration path is possible because the logic lives in framework-agnostic packages. |

---

## 12. Post-v1 ideas
- Factions and relationships (M14), rivers and erosion (M15), plugins (M16), the canvas (M17) and live collaboration (M18 and M20) are milestones now (M14 to M18 done).
- Image generation for structures/themes via AI; ambient soundscapes per theme. (Image generation would need a remote service, against keeping everything local.)

---

## 13. Immediate next steps
1. **The Microsoft Store:** register in Partner Center (free), reserve *Universe*, add its identity as repository variables, and submit `main`'s `.appx` (README, *Putting Universe in the Microsoft Store*).
2. **Certificates (finishes M19, for the downloads from GitHub and for macOS):** an Azure Artifact Signing account and certificate profile for Windows, and an Apple Developer ID for macOS, added as repository secrets (names in the README); the next `main` and `staging` builds are then signed, and SmartScreen learns their reputation as they're downloaded.
3. **Verified commits:** the owner's commit-signing key given to the cloud environment (as a secret, never in the chat) with its public half on the owner's GitHub account, so commits show as Verified.
4. **Finishing M20:** two people, each on their own tailnet with a machine shared between them, try sharing a universe on `staging`: inviting to view and to edit, changing one thing at once, and a conflict note put back.
5. **M22**, worlds up close.
