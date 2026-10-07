#!/usr/bin/env node
// Writes the update.json the app's self-updater reads (apps/desktop/src/shared/update.ts):
//   node scripts/update-manifest.mjs <dir with the installers> <version> <commit>
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Installer file name → `${InstallKind}-${arch}`.
const KINDS = [
  [/-windows-portable\.exe$/, 'win-portable-x64'],
  [/-win-x64\.exe$/, 'win-nsis-x64'],
  [/-mac-arm64\.zip$/, 'mac-zip-arm64'],
  [/-mac-x64\.zip$/, 'mac-zip-x64'],
  [/-x86_64\.AppImage$/, 'linux-appimage-x64'],
  [/-amd64\.deb$/, 'linux-deb-x64']
]

const [dir, version, commit] = process.argv.slice(2)
if (!dir || !version || !commit) throw new Error('usage: update-manifest.mjs <dir> <version> <commit>')

const files = {}
for (const name of readdirSync(dir)) {
  const key = KINDS.find(([pattern]) => pattern.test(name))?.[1]
  if (!key) continue
  const path = join(dir, name)
  files[key] = { name, sha512: createHash('sha512').update(readFileSync(path)).digest('base64'), size: statSync(path).size }
}
for (const [, key] of KINDS) if (!files[key]) console.error(`warning: no installer for ${key}`)
process.stdout.write(JSON.stringify({ version, commit, files }, null, 2) + '\n')
