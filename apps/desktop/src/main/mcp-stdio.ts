import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { BuildInfo } from '../shared/api'

declare const __BUILD_INFO__: BuildInfo

/**
 * The MCP server over stdio, run by an AI client: no window, no dock icon;
 * it ends when the client closes its input. Electron's own process can't read
 * stdin on Windows, so it starts itself again as plain Node
 * (ELECTRON_RUN_AS_NODE), which takes over the client's pipes, and ends
 * when that does. The same on every system, so each is tested the same way.
 */
if (process.env.ELECTRON_RUN_AS_NODE) void serve()
else void relaunchAsNode()

async function serve(): Promise<void> {
  // Stdout carries the protocol and nothing else: anything logged goes to stderr.
  for (const level of ['log', 'info', 'debug'] as const) console[level] = (...args: unknown[]) => console.error(...args)
  const at = process.argv.indexOf('--project')
  const project = at >= 0 ? process.argv[at + 1] : undefined
  try {
    const { serveStdio } = await import('@universe/api')
    await serveStdio({ project, version: __BUILD_INFO__.version, input: process.stdin, output: process.stdout })
    process.exit(0)
  } catch (err) {
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`)
    process.exit(1)
  }
}

async function relaunchAsNode(): Promise<void> {
  const { app } = await import('electron')
  app.dock?.hide()
  // This app's main script, next to this one (inside its archive when packaged), with the same flags.
  const child = spawn(process.execPath, [join(__dirname, 'index.js'), ...process.argv.slice(process.argv.indexOf('--mcp'))], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    windowsHide: true
  })
  child.on('error', (err) => {
    process.stderr.write(`Couldn’t start the MCP server: ${err.message}\n`)
    app.exit(1)
  })
  child.on('exit', (code) => app.exit(code ?? 1))
}
