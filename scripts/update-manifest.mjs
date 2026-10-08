#!/usr/bin/env node
// Writes the update.json the app's self-updater reads (apps/desktop/src/shared/update.ts):
//   node scripts/update-manifest.mjs <dir with the installers> <version> <commit> [platform…]
// It fails, writing nothing, unless every installer of the given platforms (win, mac and linux
// by default) is there and stamped with <version>: a manifest must never point at a missing
// or older file.
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

const [dir, version, commit, ...platforms] = process.argv.slice(2)
if (!dir || !version || !commit) throw new Error('usage: update-manifest.mjs <dir> <version> <commit> [win|mac|linux…]')
const wanted = platforms.length ? platforms : ['win', 'mac', 'linux']

const files = {}
for (const name of readdirSync(dir)) {
  const key = KINDS.find(([pattern]) => pattern.test(name))?.[1]
  if (!key) continue
  const path = join(dir, name)
  files[key] = { name, sha512: createHash('sha512').update(readFileSync(path)).digest('base64'), size: statSync(path).size }
}

const problems = []
for (const [, key] of KINDS) {
  if (!wanted.includes(key.split('-')[0])) continue
  if (!files[key]) problems.push(`no installer for ${key}`)
  else if (!files[key].name.includes(version)) problems.push(`${files[key].name} is not stamped with version ${version}`)
}
if (problems.length) {
  console.error(`update-manifest: ${problems.join('; ')}`)
  process.exit(1)
}
process.stdout.write(JSON.stringify({ version, commit, files }, null, 2) + '\n')
