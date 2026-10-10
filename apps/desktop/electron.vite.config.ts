import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import pkg from './package.json'

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
if (!['main', 'staging', 'dev'].includes(channel)) throw new Error(`UNIVERSE_CHANNEL is ${channel}: it's main, staging or dev`)

const buildInfo = JSON.stringify({ version: pkg.version, commit: commit(), builtAt: new Date().toISOString(), channel })

// Workspace packages are TypeScript sources, so they must be bundled, not externalized.
const workspace = ['@universe/api', '@universe/core', '@universe/db', '@universe/procgen', '@universe/sim']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspace })],
    define: { __BUILD_INFO__: buildInfo },
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
