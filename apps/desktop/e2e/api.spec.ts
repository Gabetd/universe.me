import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Page } from '@playwright/test'
import electronPath from 'electron'
import { closeProject, expect, inspector, newWorld, row, shot, state, stubSaveDialog, test, type AppHandle } from './helpers'

/** Where the app says its API is (each test's own file, see `launch`). */
const discovery = (h: AppHandle) => JSON.parse(readFileSync(join(h.dir, 'api.json'), 'utf8')) as { port: number | null; token: string; project: string | null }

/** An MCP client talking to the app over HTTP, as Claude Code does with `--transport http`. */
function httpMcp(h: AppHandle): Rpc {
  let id = 0
  return async (method, params = {}) => {
    const { port, token } = discovery(h)
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
    })
    return res.json()
  }
}

type Rpc = (method: string, params?: object) => Promise<{ result: { content: { text: string }[] } & Record<string, unknown> }>

/** A tool's answer, read as JSON, from either kind of client. */
const tool = async (call: Rpc, name: string, args: object) => JSON.parse((await call('tools/call', { name, arguments: args })).result.content[0]!.text)

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }

const worldId = async (page: Page) => (await state(page, 'nodes')).find((n) => n.kind === 'world')!.id

test('an AI client over MCP: its changes show at once and undo in one click, or wait for review; the REST API and the world bible', async ({ h }) => {
  test.slow()
  const { page } = h
  await newWorld(h, 'Aerth')
  const id = await worldId(page)

  // The Connect AI panel: on, where, and the command to add it to Claude Code.
  await page.getByRole('button', { name: 'Connect AI' }).click()
  const panel = page.getByRole('region', { name: 'Connect AI' })
  await expect(panel.getByLabel('Connection status')).toHaveText(`Listening on 127.0.0.1:${discovery(h).port}.`)
  await expect(panel.getByLabel(/Add to Claude Code/)).toHaveValue(new RegExp(`claude mcp add --transport http universe http://127\\.0\\.0\\.1:${discovery(h).port}/mcp`))
  await expect(panel.getByLabel(/stdio server/)).toHaveValue(/--mcp --project ['"].*Aerth\.universe['"]$/)
  await shot(page, '120-connect-ai')
  await page.getByRole('button', { name: 'Close connect AI' }).click()

  const mcp = httpMcp(h)
  const init = await mcp('initialize', INIT)
  expect(init.result.serverInfo).toMatchObject({ name: 'universe' })
  const worlds = await tool(mcp, 'list_worlds', {})
  expect(worlds.worlds[0].name).toBe('Terra Surface')

  // A change from the AI shows in the app at once, with a note, and the topbar offers to undo it.
  const comet = await tool(mcp, 'create_event', { worldId: id, title: 'The comet', start: '1204', notes: 'It burned for a month.' })
  expect(comet.status).toBe('applied')
  await expect(page.getByRole('status', { name: 'AI changes' })).toContainText('Added the event “The comet” (1204)')
  await expect.poll(async () => (await state(page, 'timeline')).events.map((e) => e.title)).toEqual(['The comet'])
  await tool(mcp, 'create_event', { worldId: id, title: 'The flood', start: '1210' })
  const undoAi = page.getByRole('button', { name: 'Undo AI (2)' })
  await expect(undoAi).toBeVisible()
  await page.getByRole('toolbar', { name: 'Timeline' }).getByRole('button', { name: 'Fit' }).click()
  await shot(page, '121-ai-change')
  await undoAi.click()
  await expect.poll(async () => (await state(page, 'timeline')).events.length).toBe(0)
  await expect(page.getByRole('button', { name: /Undo AI/ })).toHaveCount(0)

  // Review mode: AI changes wait as suggestions to accept or reject.
  await page.getByRole('button', { name: 'Connect AI' }).click()
  await panel.getByLabel('Review AI changes before they apply').check()
  const proposed = await tool(mcp, 'create_event', { worldId: id, title: 'The founding of Vel', start: '1300' })
  expect(proposed.status).toBe('proposed')
  await tool(mcp, 'create_event', { worldId: id, title: 'A rumour', start: '1301' })
  const suggestions = page.getByRole('region', { name: 'AI suggestions' })
  await expect(suggestions).toContainText('2 suggested changes')
  await page.getByRole('button', { name: 'Close connect AI' }).click()
  await shot(page, '122-ai-suggestions')
  expect((await state(page, 'timeline')).events).toHaveLength(0)
  await suggestions.getByRole('listitem').filter({ hasText: 'The founding of Vel' }).getByRole('button', { name: 'Accept' }).click()
  await suggestions.getByRole('listitem').filter({ hasText: 'A rumour' }).getByRole('button', { name: 'Reject' }).click()
  await expect(suggestions).toHaveCount(0)
  await expect.poll(async () => (await state(page, 'timeline')).events.map((e) => e.title)).toEqual(['The founding of Vel'])

  // The REST API answers too, and only with the token.
  const { port, token } = discovery(h)
  const events = await fetch(`http://127.0.0.1:${port}/v1/worlds/${id}/events`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json())
  expect(events.events[0].title).toBe('The founding of Vel')
  expect((await fetch(`http://127.0.0.1:${port}/v1/worlds`)).status).toBe(401)

  // The world bible, from the world's inspector.
  await row(page, 'Terra Surface').click()
  const bible = join(h.dir, 'Terra.md')
  await stubSaveDialog(h.app, bible)
  await inspector(page).getByRole('button', { name: 'Export world bible…' }).click()
  await expect(inspector(page).getByLabel('Exported to')).toContainText('Terra.md')
  expect(readFileSync(bible, 'utf8')).toContain('### 1300: The founding of Vel')

  // Turned off, nothing listens.
  await page.getByRole('button', { name: 'Connect AI' }).click()
  await panel.getByLabel('Let AI connect').uncheck()
  await expect(panel.getByLabel('Connection status')).toHaveText('Off: no client can connect.')
  await expect(fetch(`http://127.0.0.1:${port}/v1/worlds`, { headers: { Authorization: `Bearer ${token}` } })).rejects.toThrow()
})

/** The stdio MCP server, started the way Claude Code starts it: this app's executable with --mcp. */
function stdioMcp(h: AppHandle, project: string) {
  const packaged = process.env.UNIVERSE_E2E_EXECUTABLE
  const args = [...(packaged ? [] : [join(__dirname, '..')]), '--mcp', '--project', project, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])]
  const child = spawn(packaged ?? (electronPath as unknown as string), args, { env: { ...process.env, UNIVERSE_API_DISCOVERY: join(h.dir, 'api.json') }, stdio: ['pipe', 'pipe', 'ignore'] })
  const waiting = new Map<number, (reply: Awaited<ReturnType<Rpc>>) => void>()
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const reply = JSON.parse(line)
    waiting.get(reply.id)?.(reply)
  })
  let id = 0
  const call: Rpc = (method, params = {}) =>
    new Promise((resolve) => {
      waiting.set(++id, resolve)
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  return { call, close: () => new Promise((done) => (child.on('exit', done), child.stdin!.end())) }
}

test('the stdio MCP server goes through the app while it has the project open, and works on the file while it’s closed', async ({ h }) => {
  test.slow()
  const { page, app } = h
  await newWorld(h, 'Aerth')
  const id = await worldId(page)
  const project = (await state(page, 'project'))!.path
  const mcp = stdioMcp(h, project)
  const run = (args: object) => tool(mcp.call, 'create_event', args)
  expect((await mcp.call('initialize', INIT)).result).toMatchObject({ serverInfo: { name: 'universe' } })

  // The app has it: the change goes through the app, shows there, and undoes there.
  expect((await run({ worldId: id, title: 'Through the app', start: '10' })).status).toBe('applied')
  await expect.poll(async () => (await state(page, 'timeline')).events.map((e) => e.title)).toEqual(['Through the app'])
  await expect(page.getByRole('button', { name: 'Undo AI (1)' })).toBeVisible()

  // Closed in the app: the server opens the file itself, and the app sees the change when it opens it again.
  await closeProject(app)
  expect((await run({ worldId: id, title: 'Written to the file', start: '20' })).status).toBe('applied')
  await mcp.close()
  await page.getByRole('button', { name: /Aerth/ }).first().click()
  await expect.poll(async () => (await state(page, 'timeline')).events.map((e) => e.title).sort()).toEqual(['Through the app', 'Written to the file'])
})
