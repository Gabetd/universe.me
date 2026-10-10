#!/usr/bin/env bash
# Runs the GitHub pipelines (.github/workflows/ci.yml and build.yml) locally,
# against a clean checkout of HEAD, so a push can't turn them red.
#
#   pnpm ci:local           everything CI runs on Linux
#   pnpm ci:local --quick   skip packaging (lint, typecheck, unit + dev-build e2e only)
#
# Like CI it tests what is committed, not the working tree: uncommitted or
# untracked files are not included. Windows and macOS legs can't run here; the
# dev-build e2e pass runs at the Windows runners' 1024×768, as ci.yml's does.
#
# The app is built once, stamped with a build version as build.yml stamps it, for
# both e2e passes and the package. Lint, typecheck and unit tests run side by side;
# the e2e passes, which time things, one at a time with nothing else running.
set -euo pipefail

QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1

ROOT=$(git rev-parse --show-toplevel)
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/universe-ci
ACTIONLINT_VERSION=1.7.7
# From the release's actionlint_1.7.7_checksums.txt: the download is checked before it's run.
ACTIONLINT_SHA256=023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757
VERSION=0.1.9999
WORK=$(mktemp -d "${TMPDIR:-/tmp}/universe-ci.XXXXXX")
START=$SECONDS

step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✘ %s\033[0m\n' "$*"; exit 1; }
cleanup() {
  git -C "$ROOT" worktree remove --force "$WORK/repo" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Runs each "name: command" at once, each into its own log; once all have
# finished, shows how long each took and the output of any that failed.
parallel() {
  local names=() pids=() failed=() job name
  for job in "$@"; do
    name=${job%%:*}
    (
      start=$SECONDS status=0
      bash -c "${job#*: }" >"$WORK/$name.log" 2>&1 || status=$?
      echo $((SECONDS - start)) >"$WORK/$name.time"
      exit $status
    ) &
    names+=("$name")
    pids+=($!)
  done
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then
      printf '  \033[32m✔\033[0m %s (%ss)\n' "${names[$i]}" "$(cat "$WORK/${names[$i]}.time")"
    else
      printf '  \033[31m✘\033[0m %s (%ss)\n' "${names[$i]}" "$(cat "$WORK/${names[$i]}.time")"
      failed+=("${names[$i]}")
    fi
  done
  for name in "${failed[@]}"; do
    printf '\n\033[1;31m── %s ──\033[0m\n' "$name"
    cat "$WORK/$name.log"
  done
  ((${#failed[@]} == 0)) || fail "${failed[*]}"
}

if [[ -n $(git -C "$ROOT" status --porcelain) ]]; then
  printf '\033[33mNote: uncommitted changes are not tested (CI only sees commits).\033[0m\n'
fi

step "Workflow files (actionlint $ACTIONLINT_VERSION)"
if [[ ! -x "$CACHE/actionlint-$ACTIONLINT_VERSION" ]]; then
  mkdir -p "$CACHE"
  curl -sSfL -o "$WORK/actionlint.tar.gz" "https://github.com/rhysd/actionlint/releases/download/v$ACTIONLINT_VERSION/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
  echo "$ACTIONLINT_SHA256  $WORK/actionlint.tar.gz" | sha256sum -c --quiet - || fail "actionlint download doesn't match its checksum"
  tar -xzf "$WORK/actionlint.tar.gz" -C "$WORK" actionlint
  mv "$WORK/actionlint" "$CACHE/actionlint-$ACTIONLINT_VERSION"
fi
(cd "$ROOT" && "$CACHE/actionlint-$ACTIONLINT_VERSION" -shellcheck= .github/workflows/*.yml) || fail "workflow files have errors"

# CI installs exactly this Node (.github/actions/setup); a run on another one proves nothing about CI.
NODE_WANTED=$(<"$ROOT/.node-version")
[[ $(node --version) == "v$NODE_WANTED" ]] || fail "Node $(node --version) here, CI runs v$NODE_WANTED (.node-version): fnm use, nvm use or mise install"

# The commit tested, fixed now: a commit made while this runs isn't the one that passed.
TESTED=$(git -C "$ROOT" rev-parse HEAD)
step "Clean checkout of ${TESTED:0:7}"
git -C "$ROOT" worktree add --detach "$WORK/repo" "$TESTED" >/dev/null
cd "$WORK/repo"
export CI=true
# GitHub's Ubuntu runners have a desktop browser behind xdg-open; one that a
# test starts by accident keeps Electron from quitting. Behave the same here.
mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexec sleep 600\n' > "$WORK/bin/xdg-open"
chmod +x "$WORK/bin/xdg-open"
export PATH="$WORK/bin:$PATH"

step "Set up: install (frozen lockfile) and download Electron (.github/actions/setup)"
pnpm install --frozen-lockfile --prefer-offline >/dev/null || fail "pnpm install --frozen-lockfile failed (lockfile out of date?)"
node -e "require('electron')" >/dev/null || fail "downloading Electron"

step "Build the app, stamped $VERSION"
(cd apps/desktop && npm pkg set version=$VERSION && pnpm build >/dev/null) || fail "build"

step "Lint, typecheck and unit tests, side by side"
parallel "lint: pnpm lint" "typecheck: pnpm typecheck" "unit-tests: pnpm test"

step "ci.yml: end-to-end tests on the dev build (Xvfb, 1024×768)"
(cd apps/desktop && xvfb-run -a -s "-screen 0 1024x768x24" npx playwright test) || fail "e2e tests"

if [[ $QUICK == 0 ]]; then
  step "build.yml: package for Linux"
  (cd apps/desktop && npx electron-builder --publish never) || fail "packaging"

  step "build.yml: end-to-end tests on the packaged Linux app"
  (cd apps/desktop && UNIVERSE_E2E_EXECUTABLE=$PWD/release/linux-unpacked/universe-desktop xvfb-run -a npx playwright test) || fail "packaged app e2e"

  step "build.yml: update manifest (the Linux installers), signed with a throwaway key"
  node scripts/update-manifest.mjs apps/desktop/release $VERSION local linux > "$WORK/update.json" || fail "update manifest"
  key=$(node -e "process.stdout.write(require('node:crypto').generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))")
  x=$(UPDATE_SIGNING_KEY=$key node -e "process.stdout.write(require('node:crypto').createPublicKey(process.env.UPDATE_SIGNING_KEY).export({ format: 'jwk' }).x)")
  UPDATE_SIGNING_KEY=$key node scripts/sign-update.mjs "$WORK/update.json" "$x" > "$WORK/update.signed.json" || fail "signed update manifest"
fi

# Remembered so the pre-push hook doesn't run a full pass again for this commit.
[[ $QUICK == 0 ]] && touch "$CACHE/passed-$TESTED"
printf '\n\033[1;32m✔ Local pipeline passed in %ss\033[0m\n' $((SECONDS - START))
