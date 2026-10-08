# Working on universe.me

## Workflow rules (from the project owner)
- Commit often: one commit per working step, each passing `pnpm check`.
- Push only when a milestone (PLAN.md §9) is complete.
- Before every push, review the unpushed changes for:
  1. duplicated code (DRY): extract shared helpers instead of copy-paste,
  2. asynchronous opportunities: heavy work off the UI/main thread (Web Workers, async IPC), independent awaits in parallel,
  3. bad code to refactor: unclear names, long functions, dead code.
  Fix what's found, then run `pnpm ci:local` (the GitHub pipelines replayed locally on a clean checkout of HEAD) and push only when it passes. The pre-push hook runs it too (`git config core.hooksPath .githooks` once per clone).
- Keep PLAN.md's milestone checklist and the in-app roadmap (`apps/desktop/src/renderer/src/roadmap.ts`) in sync.
- After each push that adds features, refresh the **build log** artifact (https://claude.ai/artifact/M6aq3G6qUdXsqonJebk5qk, source `docs/build-log/index.html`): run the e2e suite with pictures (`UNIVERSE_SHOTS=1 xvfb-run -a pnpm test:e2e`), `python3 scripts/build-log-images.py`, add a `LOG` entry (and any new `SHOTS`/`AREAS`) for the new build, then republish it to that URL with the `img/*.webp` files.

## Commands
- `pnpm ci:local`: everything CI runs on Linux (actionlint, frozen install, lint, typecheck, unit, e2e, small-screen e2e, packaging, packaged-app e2e, update manifest) against committed code. `--quick` skips packaging.
- `pnpm check`: lint + typecheck + unit tests
- `xvfb-run -a pnpm test:e2e`: build, then drive the real Electron app (with `UNIVERSE_SHOTS=1` it also takes the build log's screenshots, into `apps/desktop/test-results/`)
- `pnpm dev`: run the app with hot reload

## Architecture
- Everything stays local: projects are SQLite files on disk, no accounts, no telemetry. `src/main/index.ts` (`keepOffline`) cancels every network request except the app's own files and the updater's GitHub release downloads (`src/shared/offline.ts`); `e2e/offline.spec.ts` checks it. Don't add remote services, CDNs, web fonts or analytics.
- Every write goes through the command bus in `packages/core` (validated, undoable, logged). Don't write to storage directly from the UI or main process.
- `packages/core` has no Node or DOM dependencies. `packages/db` is Node-only (`node:sqlite`). `packages/procgen` is pure TS used by both the renderer and main.
