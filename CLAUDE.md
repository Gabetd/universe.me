# Working on universe.me

## Workflow rules (from the project owner)
- Commit often: one commit per working step, each passing `pnpm check`.
- Push only when a milestone (PLAN.md §9) is complete.
- Before every push, review the unpushed changes for:
  1. duplicated code (DRY): extract shared helpers instead of copy-paste,
  2. asynchronous opportunities: heavy work off the UI/main thread (Web Workers, async IPC), independent awaits in parallel,
  3. bad code to refactor: unclear names, long functions, dead code.
  Fix what's found, re-run `pnpm check` and `xvfb-run -a pnpm test:e2e`, then push.
- Keep PLAN.md's milestone checklist and the in-app roadmap (`apps/desktop/src/renderer/src/roadmap.ts`) in sync.

## Commands
- `pnpm check`: lint + typecheck + unit tests
- `xvfb-run -a pnpm test:e2e`: build, then drive the real Electron app (screenshots land in `apps/desktop/test-results/`)
- `pnpm dev`: run the app with hot reload

## Architecture
- Every write goes through the command bus in `packages/core` (validated, undoable, logged). Don't write to storage directly from the UI or main process.
- `packages/core` has no Node or DOM dependencies. `packages/db` is Node-only (`node:sqlite`). `packages/procgen` is pure TS used by both the renderer and main.
