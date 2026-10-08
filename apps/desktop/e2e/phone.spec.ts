import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { expect, newWorld, shot, state, test, type AppHandle } from './helpers'

/** The stand-in Tailscale's name for this computer (e2e/fake-tailscale.mjs). */
const HOST = 'studio.tail1234.ts.net'
const port = (h: AppHandle) => (JSON.parse(readFileSync(join(h.dir, 'api.json'), 'utf8')) as { port: number }).port

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** A request as Funnel forwards it from the internet: to 127.0.0.1, for the public host. */
function viaFunnel(h: AppHandle, method: string, path: string, { headers = {}, body }: { headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: port(h), method, path, headers: { Host: HOST, ...headers } }, (res) => {
      let text = ''
      res.on('data', (c: Buffer) => (text += c.toString()))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const json = (body: object) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(fields).toString()
})

test('Claude on a phone: phone access through Tailscale Funnel, a sign-in with the code the app shows, changes from it, and disconnecting it', async ({ h }) => {
  test.slow()
  const { page } = h
  await newWorld(h, 'Aerth')
  const worldId = (await state(page, 'nodes')).find((n) => n.kind === 'world')!.id

  // Off to start with: the public address isn't answered.
  expect((await viaFunnel(h, 'GET', '/.well-known/oauth-protected-resource/mcp')).status).toBe(403)

  await page.getByRole('button', { name: 'Connect AI' }).click()
  const panel = page.getByRole('region', { name: 'Connect AI' })
  const phone = panel.getByRole('region', { name: 'From your phone' })
  await expect(phone.getByLabel('Phone access status')).toHaveText(`Off. Tailscale is ready on ${HOST}.`)
  await phone.getByLabel('Let Claude on my phone connect').check()
  await expect(phone.getByLabel('Phone access status')).toHaveText(`On, through Tailscale Funnel at https://${HOST}.`)
  await expect(phone.getByLabel(/custom connector/)).toHaveValue(`https://${HOST}/mcp`)
  await page.getByRole('button', { name: 'Close connect AI' }).click()

  // What claude.ai does when the connector is added: finds the sign-in, registers, and sends the user to sign in.
  const resource = JSON.parse((await viaFunnel(h, 'GET', '/.well-known/oauth-protected-resource/mcp')).body)
  expect(resource).toMatchObject({ resource: `https://${HOST}/mcp`, authorization_servers: [`https://${HOST}`] })
  const meta = JSON.parse((await viaFunnel(h, 'GET', '/.well-known/oauth-authorization-server')).body)
  expect(meta.registration_endpoint).toBe(`https://${HOST}/oauth/register`)
  const callback = 'https://claude.ai/api/mcp/auth_callback'
  const client = JSON.parse((await viaFunnel(h, 'POST', '/oauth/register', json({ client_name: 'Claude', redirect_uris: [callback] }))).body)
  const verifier = 'a-long-random-code-verifier-made-by-the-client-0123456789'
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: callback, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' })
  const signInPage = await viaFunnel(h, 'GET', `/oauth/authorize?${query}`)
  expect(signInPage.body).toContain('<b>Claude</b> wants to read and change the universe')
  const signin = /name="signin" value="([^"]+)"/.exec(signInPage.body)![1]!

  // The app shows the code to type, even with Connect AI closed.
  const code = await page.getByLabel('Code for Claude').textContent()
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  await shot(page, '130-phone-sign-in')

  // Typed on the sign-in page: back to claude.ai with a code, exchanged for tokens.
  const signedIn = await viaFunnel(h, 'POST', '/oauth/authorize', form({ signin, code: code! }, { Origin: `https://${HOST}` }))
  expect(signedIn.status).toBe(302)
  const back = new URL(signedIn.headers.location as string)
  expect(back.searchParams.get('state')).toBe('xyz')
  await expect(page.getByLabel('Code for Claude')).toHaveCount(0)
  const basic = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`
  const tokens = JSON.parse(
    (await viaFunnel(h, 'POST', '/oauth/token', form({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, redirect_uri: callback }, { Authorization: basic }))).body
  )
  expect(tokens).toMatchObject({ token_type: 'Bearer', access_token: expect.any(String), refresh_token: expect.any(String) })

  // Now Claude, from the phone, adds to the history: the change shows here like any AI client's.
  const mcp = (body: object, token = tokens.access_token as string) =>
    viaFunnel(h, 'POST', '/mcp', { headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  const call = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_event', arguments: { worldId, title: 'Written on the train', start: '1204' } } })
  expect(JSON.parse(JSON.parse(call.body).result.content[0].text).status).toBe('applied')
  await expect(page.getByRole('status', { name: 'AI changes' })).toContainText('Added the event “Written on the train” (1204)')
  await expect(page.getByRole('button', { name: 'Undo AI (1)' })).toBeVisible()

  // The app's own token is no good from outside.
  const appToken = JSON.parse(readFileSync(join(h.dir, 'api.json'), 'utf8')).token as string
  expect((await mcp({ jsonrpc: '2.0', id: 2, method: 'ping' }, appToken)).status).toBe(401)

  // Disconnected in Connect AI: its tokens stop working at once.
  await page.getByRole('button', { name: 'Connect AI' }).click()
  const connected = phone.getByRole('list', { name: 'Connected clients' })
  await expect(connected).toContainText('Claude')
  await connected.scrollIntoViewIfNeeded()
  await shot(page, '131-phone-connected')
  await connected.getByRole('button', { name: 'Remove' }).click()
  await expect(connected).toHaveCount(0)
  expect((await mcp({ jsonrpc: '2.0', id: 3, method: 'ping' })).status).toBe(401)

  // Off again: Funnel is turned off and the public address turned away.
  await phone.getByLabel('Let Claude on my phone connect').uncheck()
  await expect(phone.getByLabel('Phone access status')).toHaveText(`Off. Tailscale is ready on ${HOST}.`)
  await expect.poll(() => JSON.parse(readFileSync(join(h.dir, 'tailscale.json'), 'utf8'))).toEqual({})
  expect((await viaFunnel(h, 'GET', '/.well-known/oauth-protected-resource/mcp')).status).toBe(403)
})
