#!/usr/bin/env bash
# Runs the GitHub pipelines (.github/workflows/ci.yml and build.yml) locally,
# against a clean checkout of HEAD, so a push can't turn them red.
#
#   pnpm ci:local           everything CI runs on Linux, plus a small-screen pass
#   pnpm ci:local --quick   skip packaging (lint, typecheck, unit + e2e only)
#
# Like CI it tests what is committed, not the working tree: uncommitted or
# untracked files are not included. Windows and macOS legs can't run here; the
# small-screen e2e pass stands in for the Windows runners' 1024×768 display.
set -euo pipefail

QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1

ROOT=$(git rev-parse --show-toplevel)
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/universe-ci
ACTIONLINT_VERSION=1.7.7
WORK=$(mktemp -d "${TMPDIR:-/tmp}/universe-ci.XXXXXX")
START=$SECONDS

step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✘ %s\033[0m\n' "$*"; exit 1; }
cleanup() {
  git -C "$ROOT" worktree remove --force "$WORK/repo" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

if [[ -n $(git -C "$ROOT" status --porcelain) ]]; then
  printf '\033[33mNote: uncommitted changes are not tested (CI only sees commits).\033[0m\n'
fi

step "Workflow files (actionlint $ACTIONLINT_VERSION)"
if [[ ! -x "$CACHE/actionlint-$ACTIONLINT_VERSION" ]]; then
  mkdir -p "$CACHE"
  curl -sSfL "https://github.com/rhysd/actionlint/releases/download/v$ACTIONLINT_VERSION/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" | tar -xz -C "$WORK" actionlint
  mv "$WORK/actionlint" "$CACHE/actionlint-$ACTIONLINT_VERSION"
fi
(cd "$ROOT" && "$CACHE/actionlint-$ACTIONLINT_VERSION" -shellcheck= .github/workflows/*.yml) || fail "workflow files have errors"

step "Clean checkout of $(git -C "$ROOT" rev-parse --short HEAD)"
git -C "$ROOT" worktree add --detach "$WORK/repo" HEAD >/dev/null
cd "$WORK/repo"
export CI=true
# GitHub's Ubuntu runners have a desktop browser behind xdg-open; one that a
# test starts by accident keeps Electron from quitting. Behave the same here.
mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexec sleep 600\n' > "$WORK/bin/xdg-open"
chmod +x "$WORK/bin/xdg-open"
export PATH="$WORK/bin:$PATH"

step "ci.yml: install (frozen lockfile)"
pnpm install --frozen-lockfile --prefer-offline >/dev/null || fail "pnpm install --frozen-lockfile failed (lockfile out of date?)"

step "ci.yml: lint"
pnpm lint || fail "lint"
step "ci.yml: typecheck"
pnpm typecheck || fail "typecheck"
step "ci.yml: unit tests"
pnpm test || fail "unit tests"
step "ci.yml: end-to-end tests (Xvfb)"
xvfb-run -a pnpm test:e2e || fail "e2e tests"

step "Small screen e2e (1024×768, like the Windows runners)"
(cd apps/desktop && xvfb-run -a -s "-screen 0 1024x768x24" npx playwright test) || fail "e2e tests on a small screen"

if [[ $QUICK == 0 ]]; then
  step "build.yml: stamp version and package for Linux"
  (cd apps/desktop && npm pkg set version=0.1.9999 && pnpm dist) || fail "packaging"

  step "build.yml: smoke-test the packaged Linux app"
  (cd apps/desktop && UNIVERSE_E2E_EXECUTABLE=$PWD/release/linux-unpacked/universe-desktop xvfb-run -a npx playwright test) || fail "packaged app e2e"

  step "build.yml: update manifest"
  node scripts/update-manifest.mjs apps/desktop/release 0.1.9999 local > "$WORK/update.json"
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    for (const key of ["linux-appimage-x64", "linux-deb-x64"]) if (!m.files[key]) throw new Error("manifest has no " + key)
    if (!m.files["linux-appimage-x64"].name.includes("0.1.9999")) throw new Error("installers are not stamped with the build version")
  ' "$WORK/update.json" || fail "update manifest"
fi

# Remembered so the pre-push hook doesn't run a full pass again for this commit.
[[ $QUICK == 0 ]] && touch "$CACHE/passed-$(git -C "$ROOT" rev-parse HEAD)"
printf '\n\033[1;32m✔ Local pipeline passed in %ss\033[0m\n' $((SECONDS - START))
