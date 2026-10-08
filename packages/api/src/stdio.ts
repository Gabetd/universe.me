import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { Project } from '@universe/db'
import { apiContext } from './catalog'
import { canonical, readDiscovery, withProjectLock, type Discovery } from './discovery'
import { errorMessage } from './errors'
import { ApiError } from './host'
import { McpServer, type JsonRpcMessage } from './mcp'
import { projectHost } from './project-host'

/** Methods that don't read the project, so they're answered without opening it. */
const NO_PROJECT = new Set(['initialize', 'ping', 'tools/list', 'prompts/list', 'resources/templates/list'])
const needsProject = (method: string | undefined) => !!method && !NO_PROJECT.has(method) && !method.startsWith('notifications/')

/** How long the file stays open (and locked) after a message, for the next one: well within the app's wait to open it. */
const KEEP_OPEN_MS = 1000

/**
 * MCP over stdio (PLAN.md §6.2), as `Universe --mcp --project <file>` runs it:
 * newline-delimited JSON-RPC in and out. Each message goes to the running
 * app when it has the project open (so changes show there at once and can be
 * undone), and otherwise to the project file itself, opened and locked while
 * messages keep coming.
 */
export async function serveStdio(options: { project?: string; version: string; input: Readable; output: Writable; discovery?: string }): Promise<void> {
  const wanted = options.project ? canonical(options.project) : undefined
  let open: Project | undefined
  let unavailable = 'No project: start the server with --project <file.universe>, or open one in Universe'
  const file = () => {
    if (!open) throw new ApiError(409, unavailable)
    return open
  }
  const local = new McpServer(apiContext(projectHost(file)), options.version)
  /** Whether the app has `wanted` open, or is opening it: then it's the app's. */
  const appHasIt = (app = readDiscovery(options.discovery)) =>
    !!app && [app.project, app.opening].some((p) => p && (!wanted || canonical(p) === wanted))

  // The file stays open (and locked) between messages that come close together.
  let held: { release(): void; done: Promise<void> } | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  const release = () => {
    clearTimeout(idle)
    held?.release()
    held = undefined
  }
  /** Opens and locks the file until `release`; false if the app turned out to have it. */
  const hold = async (path: string): Promise<boolean> => {
    if (held) return true
    let opened!: (yes: boolean) => void
    const ready = new Promise<boolean>((r) => (opened = r))
    let letGo: (() => void) | undefined
    let failure: unknown
    const done = withProjectLock(path, async () => {
      // The app may have started opening it while we waited for the lock: then it's the app's.
      if (appHasIt()) return
      open = Project.open(path)
      opened(true)
      await new Promise<void>((r) => (letGo = r))
      open.close()
      open = undefined
    })
      .catch((err: unknown) => void (failure = err))
      .finally(() => opened(false))
    held = { release: () => letGo?.(), done }
    if (await ready) return true
    held = undefined
    if (failure) throw failure
    return false
  }

  const answer = async (message: JsonRpcMessage): Promise<unknown> => {
    let app = readDiscovery(options.discovery)
    if (appHasIt(app)) {
      release()
      // Opening it: wait (a few seconds at most) until it's open.
      for (let tries = 0; app?.opening && tries < 120; tries++) {
        await new Promise((r) => setTimeout(r, 50))
        app = readDiscovery(options.discovery)
      }
      if (app?.opening) throw new ApiError(409, 'Universe is still opening this project; try again')
      if (!app || !appHasIt(app)) return answer(message)
      if (app.port === null) {
        unavailable = 'Universe has this project open but isn’t taking connections: see Connect AI in Universe.'
        return local.handle(message)
      }
      unavailable = 'No project is open'
      try {
        return await forward(app, message)
      } catch (err) {
        // The app went away (quit, crashed): its file is free again.
        if ((err as { cause?: { code?: string } }).cause?.code !== 'ECONNREFUSED') throw err
      }
    }
    if (!wanted || !needsProject(message.method)) return local.handle(message)
    if (!(await hold(wanted))) return answer(message)
    try {
      return await local.handle(message)
    } finally {
      clearTimeout(idle)
      idle = setTimeout(release, KEEP_OPEN_MS)
    }
  }

  const lines = createInterface({ input: options.input, crlfDelay: Infinity })
  // One message at a time, in order.
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
      reply = 'id' in message ? { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: errorMessage(err) } } : undefined
    }
    if (reply) options.output.write(`${JSON.stringify(reply)}\n`)
  }
  release()
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
