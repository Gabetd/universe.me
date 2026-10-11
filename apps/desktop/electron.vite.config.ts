import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import pkg from './package.json'
import { CHANNELS } from './src/shared/update'

function commit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'dev'
  }
}

/** The branch it's built from (build.yml sets it): main, staging or dev. */
const channel = process.env.UNIVERSE_CHANNEL || 'main'
if (!Object.hasOwn(CHANNELS, channel)) throw new Error(`UNIVERSE_CHANNEL is ${channel}: it's main, staging or dev`)

const buildInfo = JSON.stringify({ version: pkg.version, commit: commit(), builtAt: new Date().toISOString(), channel })

/** The English dictionary's files, bundled into the main process (its package exports only its loader). */
const dictionaryFiles = dirname(createRequire(import.meta.url).resolve('dictionary-en'))

// Workspace packages are TypeScript sources, so they must be bundled, not externalized.
const workspace = ['@universe/api', '@universe/core', '@universe/db', '@universe/procgen', '@universe/sim']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspace })],
    define: { __BUILD_INFO__: buildInfo },
    resolve: { alias: { 'dictionary-en-files': dictionaryFiles } },
    build: { rollupOptions: { external: ['node:sqlite'] } }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspace })]
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    define: { __BUILD_INFO__: buildInfo },
    worker: { format: 'es' }
  }
})
