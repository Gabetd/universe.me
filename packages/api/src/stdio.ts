import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { Project } from '@universe/db'
import { apiContext } from './catalog'
import { canonical, readDiscovery, withProjectLock, type Discovery } from './discovery'
import { ApiError, type ApiHost } from './host'
import { McpServer, type JsonRpcMessage } from './mcp'

/** Methods that don't read the project, so they're answered without opening it. */
const NO_PROJECT = new Set(['initialize', 'ping', 'tools/list', 'prompts/list', 'resources/templates/list'])

/**
 * MCP over stdio (PLAN.md §6.2), as `universe-mcp --project <file>` runs it:
 * newline-delimited JSON-RPC in and out. Each message goes to the running
 * app when it has the project open (so changes show there at once and can be
 * undone), and otherwise to the project file itself, opened (and locked)
 * just for that message.
 */
export async function serveStdio(options: { project?: string; version: string; input: Readable; output: Writable; discovery?: string }): Promise<void> {
  const wanted = options.project ? canonical(options.project) : undefined
  // The file opened for the message being answered, if any.
  let open: Project | undefined
  let unavailable: string | undefined
  const host: ApiHost = {
    project: () => {
      if (!open) throw new ApiError(409, unavailable ?? 'No project: start the server with --project <file.universe>, or open one in Universe')
      const { name, rootId } = open.info()
      return { name, rootId, data: open.snapshot() }
    },
    terrainLayers: (worldId) => open!.terrain(worldId),
    write: (command) => ({ status: 'applied', target: open!.bus.execute(command, 'ai').target })
  }
  const local = new McpServer(apiContext(host), options.version)

  const answer = async (message: JsonRpcMessage): Promise<unknown> => {
    const app = readDiscovery(options.discovery)
    const appHasIt = app?.project && (!wanted || canonical(app.project) === wanted)
    if (app && appHasIt) {
      if (app.port !== null) return forward(app, message)
      unavailable = 'Universe has this project open with connections turned off. Turn on “Let AI connect” in Universe → Connect Claude.'
      return local.handle(message)
    }
    unavailable = undefined
    if (!wanted || NO_PROJECT.has(message.method ?? '')) return local.handle(message)
    return withProjectLock(wanted, async () => {
      open = Project.open(wanted)
      try {
        return await local.handle(message)
      } finally {
        open.close()
        open = undefined
      }
    })
  }

  const lines = createInterface({ input: options.input, crlfDelay: Infinity })
  // One message at a time, in order: each may open and close the project.
  for await (const line of lines) {
    if (!line.trim()) continue
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      options.output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Not JSON' } })}\n`)
      continue
    }
    let reply: unknown
    try {
      reply = await answer(message)
    } catch (err) {
      reply = 'id' in message ? { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: (err as Error).message } } : undefined
    }
    if (reply) options.output.write(`${JSON.stringify(reply)}\n`)
  }
}

/** Passes a message to the app's MCP endpoint, and its answer back. */
async function forward(app: Discovery, message: JsonRpcMessage): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${app.port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${app.token}` },
    body: JSON.stringify(message)
  })
  if (res.status === 202) return undefined
  if (!res.ok) throw new Error(`Universe answered ${res.status}: ${await res.text()}`)
  return res.json()
}
