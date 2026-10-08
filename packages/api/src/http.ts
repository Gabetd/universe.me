import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OPERATIONS, pathParams } from './catalog'
import { errorMessage, errorStatus } from './errors'
import { ApiError } from './host'
import { McpServer } from './mcp'
import { openApi } from './openapi'
import type { ApiContext, Operation } from './operation'

/** What the change feed sends: something changed, why, and who did it. */
export interface ChangeEvent {
  /** What happened, for people ("Added the event “The fall of Tarn”"). */
  summary: string
  source: 'user' | 'ai' | 'system'
  at: string
}

const MAX_BODY = 8 * 1024 * 1024

/** One route of an operation: its pattern, and which captures are which input. */
interface Route {
  op: Operation
  pattern: RegExp
  params: string[]
}

const routes: Route[] = OPERATIONS.map((op) => ({
  op,
  params: pathParams(op),
  pattern: new RegExp(`^/v1${op.route.path.replace(/:(\w+)/g, '([^/]+)')}$`)
}))

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const text = typeof body === 'string' && !type.startsWith('application/json') ? body : JSON.stringify(body, null, 2)
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(text)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new ApiError(413, 'The request is too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError(400, 'The body is not JSON')
  }
}

/** A path part as written, its %-escapes decoded; a broken escape is the client's mistake. */
function decodePart(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    throw new ApiError(400, `“${part}” is not a valid path part`)
  }
}

/** Query string values: one value as text, repeated keys as a list. */
function queryInput(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key)
    out[key] = values.length > 1 ? values : values[0]!
  }
  return out
}

/**
 * The local API server (PLAN.md §6.1): the REST routes of every operation
 * under /v1, its OpenAPI description, a change feed, and MCP at /mcp. It
 * listens on the loopback interface only, wants the bearer token on every
 * request, and turns away requests from web pages (an Origin header) and
 * for other hosts (DNS rebinding).
 */
export class ApiServer {
  private server: Server | undefined
  private readonly mcp: McpServer
  private readonly feeds = new Set<ServerResponse>()
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private port = 0
  /** The OpenAPI description, made once. */
  private spec: object | undefined

  /** Serves `ctx`'s project (see `apiContext`), which the host may share with its own uses of the API. */
  constructor(
    private readonly ctx: ApiContext,
    private readonly options: { token: string; version: string }
  ) {
    this.mcp = new McpServer(ctx, options.version)
  }

  /** Starts listening on 127.0.0.1 (`port` 0 picks a free one); resolves to the port. Fails if the port is taken. */
  listen(port: number): Promise<number> {
    const server = createServer((req, res) => void this.serve(req, res))
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        this.server = server
        this.port = (server.address() as AddressInfo).port
        // Keeps feeds open through proxies and idle timeouts.
        this.heartbeat = setInterval(() => this.feeds.forEach((r) => r.write(': still here\n\n')), 25_000)
        this.heartbeat.unref()
        resolve(this.port)
      })
    })
  }

  close(): Promise<void> {
    clearInterval(this.heartbeat)
    for (const feed of this.feeds) feed.end()
    this.feeds.clear()
    const server = this.server
    this.server = undefined
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()))
  }

  /** Tells every change feed that the project changed. */
  changed(event: ChangeEvent): void {
    const line = `event: change\ndata: ${JSON.stringify(event)}\n\n`
    for (const feed of this.feeds) feed.write(line)
  }

  private allowed(req: IncomingMessage): string | undefined {
    if (req.headers.origin) return 'Requests from web pages are not allowed'
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return 'Wrong host'
    const given = Buffer.from(/^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '')
    const token = Buffer.from(this.options.token)
    if (given.length !== token.length || !timingSafeEqual(given, token)) return 'unauthorized'
    return undefined
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const refused = this.allowed(req)
      if (refused === 'unauthorized') {
        res.setHeader('WWW-Authenticate', 'Bearer')
        return send(res, 401, { error: 'A bearer token is needed: copy it from Connect AI in Universe' })
      }
      if (refused) return send(res, 403, { error: refused })
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      if (url.pathname === '/mcp') return await this.serveMcp(req, res)
      if (req.method === 'GET' && url.pathname === '/v1/openapi.json') return send(res, 200, (this.spec ??= openApi(OPERATIONS, this.options.version)))
      if (req.method === 'GET' && url.pathname === '/v1/changes') return this.openFeed(res)
      const matching = routes.filter((r) => r.pattern.test(url.pathname))
      if (matching.length && !matching.some((r) => r.op.route.method === req.method)) {
        res.setHeader('Allow', matching.map((r) => r.op.route.method).join(', '))
        return send(res, 405, { error: `Use ${matching.map((r) => r.op.route.method).join(' or ')} here` })
      }
      const route = matching.find((r) => r.op.route.method === req.method)
      if (route) {
        const match = route.pattern.exec(url.pathname)!
        const params = Object.fromEntries(route.params.map((p, i) => [p, decodePart(match[i + 1]!)]))
        const body = req.method === 'GET' ? queryInput(url) : await readJson(req)
        if (typeof body !== 'object' || body === null || Array.isArray(body)) return send(res, 400, { error: 'The body must be a JSON object' })
        const input = route.op.input.parse({ ...body, ...params })
        const result = await route.op.run(this.ctx, input)
        return typeof result === 'string' ? send(res, 200, result, 'text/markdown; charset=utf-8') : send(res, 200, result)
      }
      send(res, 404, { error: `No route ${req.method} ${url.pathname}. See /v1/openapi.json` })
    } catch (err) {
      send(res, errorStatus(err), { error: errorMessage(err) })
    }
  }

  /** MCP's Streamable HTTP transport, answering each POST with JSON (this server never streams or calls back). */
  private async serveMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'DELETE') return void res.writeHead(204).end()
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return send(res, 405, { error: 'This MCP server answers POSTs only' })
    }
    let message: unknown
    try {
      message = await readJson(req)
    } catch (err) {
      return send(res, err instanceof ApiError && err.status === 413 ? 413 : 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: errorMessage(err) } })
    }
    const answer = await this.mcp.handle(message)
    if (!answer) return void res.writeHead(202).end()
    send(res, 200, answer)
  }

  private openFeed(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    res.write(': connected\n\n')
    this.feeds.add(res)
    res.on('close', () => this.feeds.delete(res))
  }
}
