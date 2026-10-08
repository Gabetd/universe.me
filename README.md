# Universe

A desktop worldbuilding app: build universes, galaxies, star systems and
worlds, give them histories on a timeline, and (soon) let Claude Code help
through an API. See [PLAN.md](PLAN.md) for the full design and roadmap.

**Status:** M0 (Foundations), M1 (Worlds & globe), M2 (Timeline), M3
(Structures) and M4 (Star systems & simulation) are done. You can create `.universe` project files and build the universe tree
(cluster → galaxy → star system → planet → moon / world surface). Each world
surface is generated from a seed: type any word and you get a whole planet
(land type, water, islands, mountains, climate, colors), the same planet every
time. Or customize every option yourself; either way a world code recreates
that exact planet anywhere. View it as a 3D globe or a flat map, sculpt the
terrain, paint biomes, change the sea level, draw named regions, and write
rich-text notes.

Every world (and every other node) has a timeline: past on the left, future
on the right. Add events and eras, drag them around, link causes to effects,
group events, and place them on the map. Move the playhead and the map shows
the world as of then: regions founded, renamed and dissolved over time.

Place structures from a library of detailed prebuilt blueprints (castles, a
vast walled city, villages, slums, war camps, nomad camps, harbours,
cathedrals, palaces and more), build your own from simple shapes, or import
glTF models. Each structure is maintained or left to weather from any moment
on; weathered ones crumble at the pace of their materials until they erode
away, and events can build, damage, repair, rename or destroy everything in
a radius, a region, or a list.

Zoom all the way in and you're on the ground: hills, woods, meadows and rocks
of the local biome in 1 km chunks, buildings at their real size, and your
characters life-size. Characters have a lifespan and a journey; send them
from place to place, or to an event, and they walk there over time. From
orbit, each planet and moon shows its real surface.

Star systems are simulated: give the star a mass and each planet and moon an
orbit and a spin, and watch them go round as the timeline plays. A world's
calendar follows from its day, year and moon; the timeline shows the moon's
phases and the eclipses; and the star and distance set the world's climate,
which its biomes follow. Each world has a species library and food web.
Structures now weather material by material in the local climate: the
thatched roof goes long before the stone walls. Everything can be undone,
and everything stays on your computer.

## Download and run

Every push to `main` or the development branch builds the app for every OS.
Get the newest build from the
[**latest-build** release](https://github.com/Gabetd/universe.me/releases/tag/latest-build):

| OS | File | How to run |
|---|---|---|
| Windows | `Universe-…-windows-portable.exe` | Double-click. No install needed. If SmartScreen appears: **More info → Run anyway**. |
| Windows (installer) | `Universe-…-win-x64.exe` | Installs to Program Files and adds a Start menu entry. |
| macOS, Apple Silicon | `Universe-…-mac-arm64.dmg` | Drag to Applications. The first time, open it, then **System Settings → Privacy & Security → Open Anyway**. |
| macOS, Intel | `Universe-…-mac-x64.dmg` | Same as above. |
| Linux | `Universe-…-linux-x86_64.AppImage` | `chmod +x` it, then run it. Or install the `.deb`. |

The builds aren't code-signed yet, which is why the OS asks for confirmation.

## Develop

Requires Node.js 22.13+ (24 recommended) and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm dev          # launch the app with hot reload
pnpm check        # lint + typecheck + unit tests
pnpm test:e2e     # build, then drive the real app with Playwright
pnpm dist         # package an installer for the current OS into apps/desktop/release/
```

Electron downloads its binary the first time it runs.

## Layout

```
apps/desktop/      Electron app: main process, preload bridge, React renderer
packages/core/     Domain model, Zod schemas, command bus with undo/redo, queries
packages/db/       .universe project files on SQLite (Node's built-in node:sqlite)
packages/procgen/  Seeded terrain generation, biomes, brushes, map rendering (pure TS)
```

All edits go through the command bus in `packages/core`, so the UI and
(later) the REST API and MCP server share validation, undo and the history log.
