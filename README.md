# Universe

A desktop worldbuilding app: build universes, galaxies, star systems and
worlds, give them histories on a timeline, and (soon) let Claude Code help
through an API. See [PLAN.md](PLAN.md) for the full design and roadmap.

**Status:** M0 (Foundations) is in progress. You can create and open
`.universe` project files, build the universe tree (cluster → galaxy → star
system → planet → moon / world surface), edit names, tags, seeds and notes,
and undo or redo any change. The viewport is a 2D sketch that M1 and M5
replace with real 3D scenes. The timeline is a placeholder until M2.

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
```

All edits go through the command bus in `packages/core`, so the UI and
(later) the REST API and MCP server share validation, undo and the history log.
