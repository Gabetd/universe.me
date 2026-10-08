import { z } from 'zod'
import { worldSnapshot } from './describe'
import { OPERATIONS } from './catalog'
import type { ApiContext, Operation } from './operation'
import { errorMessage } from './errors'

/**
 * The MCP server (PLAN.md §6.2), transport-agnostic: one JSON-RPC message in,
 * its answer out. Tools are the API's operations; resources are each world's
 * overview, timeline and bible; prompts start a scene or a stretch of
 * history. Served over HTTP by the app and over stdio by `--mcp`.
 */

type Id = string | number | null
export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: Id
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** Protocol versions this server speaks, newest first; a client asking for another gets the newest. */
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS = `Universe is a worldbuilding app: a universe of galaxies, star systems and worlds, each world with a timeline of events, regions, structures that weather over time, characters, species and themes (the look and tone of an age).
Start with list_worlds, then get_world for its calendar: every date is written in that world's calendar ("1204", "15 Mar 1204", "c. 1200"). get_world_snapshot shows a world at a moment; get_theme_at gives the tone and prose style guide to write in.
Every change you make is tagged as yours in the app and can be undone in one click; with review mode on, changes wait for the user to accept them.`

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

const inputSchema = (op: Operation) => z.toJSONSchema(op.input, { io: 'input', unrepresentable: 'any' })

const text = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2))

const WORLD_URI = /^universe:\/\/world\/([^/]+)(\/timeline|\/bible\.md)?$/

const PROMPTS = [
  {
    name: 'write_scene',
    title: 'Write a scene',
    description: 'A scene set on a world at a moment, in the tone of the theme in force then, from what is there at that moment.',
    arguments: [
      { name: 'worldId', description: 'The world (from list_worlds)', required: true },
      { name: 'at', description: 'When, in the world’s calendar ("1204")', required: true },
      { name: 'place', description: 'Where: a region, a structure, or a character to follow', required: false }
    ]
  },
  {
    name: 'brainstorm_history',
    title: 'Brainstorm history',
    description: 'Ideas for what happens on a world between two dates, from what is already there.',
    arguments: [
      { name: 'worldId', description: 'The world (from list_worlds)', required: true },
      { name: 'from', description: 'From when', required: true },
      { name: 'to', description: 'To when', required: true }
    ]
  }
]

export class McpServer {
  constructor(
    private readonly ctx: ApiContext,
    private readonly version: string
  ) {}

  /** Answers one message (or a batch); notifications get no answer. */
  async handle(message: unknown): Promise<JsonRpcMessage | JsonRpcMessage[] | undefined> {
    if (Array.isArray(message)) {
      const answers = (await Promise.all(message.map((m) => this.handleOne(m)))).filter((a): a is JsonRpcMessage => !!a)
      return answers.length ? answers : undefined
    }
    return this.handleOne(message)
  }

  private async handleOne(raw: unknown): Promise<JsonRpcMessage | undefined> {
    const message = raw as JsonRpcMessage
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      // Answers to requests we never send, and anything malformed without an id, need nothing back.
      return message && 'id' in message && message.method === undefined ? undefined : { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Not a JSON-RPC request' } }
    }
    const isNotification = !('id' in message)
    try {
      const result = await this.call(message.method, message.params ?? {})
      return isNotification ? undefined : { jsonrpc: '2.0', id: message.id ?? null, result }
    } catch (err) {
      if (isNotification) return undefined
      const code = err instanceof RpcError ? err.code : -32603
      return { jsonrpc: '2.0', id: message.id ?? null, error: { code, message: errorMessage(err) } }
    }
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        return {
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'universe', title: 'Universe', version: this.version },
          instructions: INSTRUCTIONS
        }
      }
      case 'ping':
        return {}
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return {}
      case 'tools/list':
        return {
          tools: OPERATIONS.map((op) => ({
            name: op.name,
            title: op.title,
            description: op.description,
            inputSchema: inputSchema(op),
            annotations: { title: op.title, readOnlyHint: !op.write, destructiveHint: false, openWorldHint: false }
          }))
        }
      case 'tools/call':
        return this.callTool(String(params.name), (params.arguments ?? {}) as Record<string, unknown>)
      case 'resources/list':
        return { resources: this.worldResources() }
      case 'resources/templates/list':
        return {
          resourceTemplates: [
            { uriTemplate: 'universe://world/{id}', name: 'World', mimeType: 'application/json', description: 'A world in full: calendar, regions, eras, themes, notes' },
            { uriTemplate: 'universe://world/{id}/timeline', name: 'World timeline', mimeType: 'application/json', description: 'Every event on a world in time order' },
            { uriTemplate: 'universe://world/{id}/bible.md', name: 'World bible', mimeType: 'text/markdown', description: 'The whole world written up as one document' }
          ]
        }
      case 'resources/read':
        return this.readResource(String(params.uri))
      case 'prompts/list':
        return { prompts: PROMPTS }
      case 'prompts/get':
        return this.prompt(String(params.name), (params.arguments ?? {}) as Record<string, string>)
      default:
        throw new RpcError(-32601, `No method ${method}`)
    }
  }

  /** A tool call: its answer, or what went wrong as a tool error the model can read and correct. */
  private async callTool(name: string, args: Record<string, unknown>) {
    const op = OPERATIONS.find((o) => o.name === name)
    if (!op) throw new RpcError(-32602, `There is no tool ${name}`)
    const input = op.input.safeParse(args)
    if (!input.success) return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${z.prettifyError(input.error)}` }] }
    try {
      return { content: [{ type: 'text', text: text(await op.run(this.ctx, input.data)) }] }
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: errorMessage(err) }] }
    }
  }

  private run(name: string, input: Record<string, unknown>) {
    const op = OPERATIONS.find((o) => o.name === name)!
    return op.run(this.ctx, op.input.parse(input))
  }

  private worldResources() {
    const project = this.ctx.host.project()
    if (!project) return []
    return project.data.nodes
      .filter((n) => n.kind === 'world')
      .flatMap((w) => [
        { uri: `universe://world/${w.id}`, name: w.name, mimeType: 'application/json', description: `${w.name}: calendar, regions, eras, themes, notes` },
        { uri: `universe://world/${w.id}/timeline`, name: `${w.name} timeline`, mimeType: 'application/json' },
        { uri: `universe://world/${w.id}/bible.md`, name: `${w.name} bible`, mimeType: 'text/markdown' }
      ])
  }

  private async readResource(uri: string) {
    const match = WORLD_URI.exec(uri)
    if (!match) throw new RpcError(-32002, `No resource ${uri}`)
    const [, worldId, part] = match
    const [value, mimeType] =
      part === '/bible.md'
        ? [await this.run('export_world_bible', { worldId }), 'text/markdown']
        : part === '/timeline'
          ? [await this.run('list_events', { worldId, limit: 1000 }), 'application/json']
          : [await this.run('get_world', { worldId }), 'application/json']
    return { contents: [{ uri, mimeType, text: text(value) }] }
  }

  private async prompt(name: string, args: Record<string, string>) {
    const { models: m } = this.ctx
    const worldId = args.worldId
    if (!worldId) throw new RpcError(-32602, 'worldId is required')
    if (name === 'write_scene') {
      const t = m.when(worldId, args.at ?? '')
      const snapshot = await worldSnapshot(m, worldId, t)
      const style = snapshot.theme?.dominant.style
      return {
        description: `A scene on ${snapshot.world}, ${snapshot.date}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                `Write a scene set on ${snapshot.world} on ${snapshot.date}${args.place ? `, at ${args.place}` : ''}.`,
                snapshot.theme ? `The age's tone: ${snapshot.theme.dominant.name}${snapshot.theme.dominant.mood.length ? ` (${snapshot.theme.dominant.mood.join(', ')})` : ''}.` : '',
                style ? `Write it this way: ${style}` : '',
                'Stay true to what is there at that moment (only these structures stand, only these people are alive):',
                JSON.stringify(snapshot, null, 2)
              ]
                .filter(Boolean)
                .join('\n\n')
            }
          }
        ]
      }
    }
    if (name === 'brainstorm_history') {
      const events = await this.run('list_events', { worldId, from: args.from, to: args.to })
      const world = await this.run('get_world', { worldId })
      return {
        description: `History between ${args.from} and ${args.to}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Brainstorm what could happen on this world between ${args.from} and ${args.to}: wars, discoveries, migrations, disasters, founding and fall. Build on what is already there and keep causes before their effects. Suggest events with dates in the world's calendar; I'll pick which to add (create_event, link_events).\n\nThe world:\n${text(world)}\n\nWhat already happens then:\n${text(events)}`
            }
          }
        ]
      }
    }
    throw new RpcError(-32602, `There is no prompt ${name}`)
  }
}
