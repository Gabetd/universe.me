import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Project } from '@universe/db'
import { ApiServer, apiContext, lockHolder, projectHost, serveStdio, writeDiscovery } from './index'
import { testProject } from './test-project'

const TOKEN = 'test-token-0123456789'
let p: ReturnType<typeof testProject>
let server: ApiServer
let base: string
const auth = { Authorization: `Bearer ${TOKEN}` }
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are checked by the expectations
type Json = any
const json = (res: Response) => res.json() as Promise<Json>

beforeEach(async () => {
  p = testProject()
  server = new ApiServer(apiContext(p.host), { token: TOKEN, version: '0.0.0-test' })
  base = `http://127.0.0.1:${await server.listen(0)}`
})
afterEach(async () => {
  await server.close()
  p.close()
})

describe('the REST API', () => {
  it('serves every operation, and only with the token, to this computer', async () => {
    const worlds = await fetch(`${base}/v1/worlds`, { headers: auth }).then(json)
    expect(worlds.worlds[0].id).toBe(p.worldId)
    expect((await fetch(`${base}/v1/worlds`)).status).toBe(401)
    expect((await fetch(`${base}/v1/worlds`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await fetch(`${base}/v1/worlds`, { headers: { ...auth, Origin: 'https://evil.example' } })).status).toBe(403)
  })

  it('takes reads from the query and writes as JSON, and says what’s wrong', async () => {
    const created = await fetch(`${base}/v1/worlds/${p.worldId}/events`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'The founding', start: '15 Mar 1204', tags: ['city'] })
    }).then(json)
    expect(created).toMatchObject({ status: 'applied', eventId: expect.any(String) })
    const listed = await fetch(`${base}/v1/worlds/${p.worldId}/events?from=1200&to=1300&tags=city`, { headers: auth }).then(json)
    expect(listed.events.map((e: { when: string }) => e.when)).toEqual(['15 Mar 1204'])
    const bad = await fetch(`${base}/v1/worlds/${p.worldId}/events`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'X', start: 'whenever' }) })
    expect(bad.status).toBe(400)
    expect((await json(bad)).error).toMatch(/not a date/)
    expect((await fetch(`${base}/v1/worlds/nope`, { headers: auth })).status).toBe(404)
    const bible = await fetch(`${base}/v1/worlds/${p.worldId}/export`, { headers: auth })
    expect(bible.headers.get('content-type')).toMatch(/markdown/)
    expect(await bible.text()).toContain('The founding')
  })

  it('describes itself in OpenAPI, and streams changes', async () => {
    const spec = await fetch(`${base}/v1/openapi.json`, { headers: auth }).then(json)
    expect(spec.paths['/v1/worlds/{worldId}/events'].post.operationId).toBe('create_event')
    expect(spec.paths['/v1/worlds/{worldId}/events'].get.parameters.map((x: { name: string }) => x.name)).toContain('tags')
    const feed = await fetch(`${base}/v1/changes`, { headers: auth })
    const reader = feed.body!.getReader()
    await reader.read()
    server.changed({ summary: 'Added the event “The founding”', source: 'ai', at: '2026-01-01T00:00:00Z' })
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toContain('event: change\ndata: {"summary":"Added the event')
    await reader.cancel()
  })
})

describe('the MCP server', () => {
  it('works with the official MCP client over HTTP: tools, resources and prompts', async () => {
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_worlds', 'create_event', 'get_world_snapshot', 'check_consistency']))
    expect(tools.find((t) => t.name === 'create_event')!.annotations?.readOnlyHint).toBe(false)

    const created = await client.callTool({ name: 'create_event', arguments: { worldId: p.worldId, title: 'The long night', start: '800' } })
    expect(JSON.parse((created.content as { text: string }[])[0]!.text)).toMatchObject({ status: 'applied' })
    const wrong = await client.callTool({ name: 'create_event', arguments: { worldId: p.worldId } })
    expect(wrong.isError).toBe(true)

    const { resources } = await client.listResources()
    const bible = resources.find((r) => r.uri.endsWith('/bible.md'))!
    const read = await client.readResource({ uri: bible.uri })
    expect((read.contents[0] as { text: string }).text).toContain('The long night')

    const { prompts } = await client.listPrompts()
    expect(prompts.map((x) => x.name)).toEqual(['write_scene', 'brainstorm_history'])
    const scene = await client.getPrompt({ name: 'write_scene', arguments: { worldId: p.worldId, at: '800' } })
    expect((scene.messages[0]!.content as { text: string }).text).toContain('Terra Surface')
    await client.close()
  })

  it('over stdio, opens the project file itself while the app doesn’t have it, and goes through the app when it does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'universe-discovery-'))
    const discovery = join(dir, 'api.json')
    const path = p.project.path
    // Closed in the "app": the server opens the file for each message.
    p.project.close()
    const input = new PassThrough()
    const output = new PassThrough()
    const replies: Record<string, unknown>[] = []
    output.on('data', (chunk: Buffer) => chunk.toString().trim().split('\n').forEach((l) => replies.push(JSON.parse(l))))
    const done = serveStdio({ project: path, version: '0.0.0-test', input, output, discovery })
    const send = (id: number, method: string, params: object = {}) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const reply = async (id: number) => {
      for (let i = 0; i < 200 && !replies.some((r) => r.id === id); i++) await new Promise((r) => setTimeout(r, 10))
      return replies.find((r) => r.id === id) as { result: { content: { text: string }[] } }
    }
    send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(await reply(1)).toMatchObject({ result: { serverInfo: { name: 'universe' } } })
    send(2, 'tools/call', { name: 'create_event', arguments: { worldId: p.worldId, title: 'Written to the file', start: '5' } })
    expect(JSON.parse((await reply(2)).result.content[0]!.text).status).toBe('applied')
    // The lock is let go after each message.
    expect(lockHolder(path)).toBeUndefined()

    // A different project open in the app: still the file.
    writeDiscovery({ pid: process.pid, port: Number(new URL(base).port), token: TOKEN, project: join(dir, 'else.universe'), version: 'x' }, discovery)
    send(3, 'tools/call', { name: 'list_worlds', arguments: {} })
    expect(JSON.parse((await reply(3)).result.content[0]!.text).project).toBe('Test')

    // Now the "app" opens it and serves it: the stdio server goes through the app, where the change can be undone.
    const app = Project.open(path)
    const appServer = new ApiServer(apiContext(projectHost(app)), { token: TOKEN, version: 'x' })
    writeDiscovery({ pid: process.pid, port: await appServer.listen(0), token: TOKEN, project: path, version: 'x' }, discovery)
    send(4, 'tools/call', { name: 'create_event', arguments: { worldId: p.worldId, title: 'Through the app', start: '6' } })
    expect(JSON.parse((await reply(4)).result.content[0]!.text).status).toBe('applied')
    expect(app.bus.canUndo).toBe(true)
    expect(app.snapshot().timeline.events.map((e) => e.title)).toEqual(['Written to the file', 'Through the app'])
    await appServer.close()
    app.close()
    input.end()
    await done
    rmSync(dir, { recursive: true, force: true })
  })
})
