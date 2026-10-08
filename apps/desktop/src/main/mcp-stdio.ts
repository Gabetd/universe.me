import { app } from 'electron'
import type { BuildInfo } from '../shared/api'

declare const __BUILD_INFO__: BuildInfo

/** The MCP server over stdio, run by an AI client: no window, no dock icon; it ends when the client closes its input. */
async function main(): Promise<void> {
  app.dock?.hide()
  const at = process.argv.indexOf('--project')
  const project = at >= 0 ? process.argv[at + 1] : undefined
  const { serveStdio } = await import('@universe/api')
  await serveStdio({ project, version: __BUILD_INFO__.version, input: process.stdin, output: process.stdout })
}

main().then(
  () => app.exit(0),
  (err: Error) => {
    process.stderr.write(`${err.stack ?? err.message}\n`)
    app.exit(1)
  }
)
