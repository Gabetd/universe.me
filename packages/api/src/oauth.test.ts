import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiServer, OAuth, apiContext, memoryStore } from './index'
import { testProject } from './test-project'

const TOKEN = 'app-token-0123456789'
const PUBLIC = 'universe.example.ts.net'
let p: ReturnType<typeof testProject>
let server: ApiServer
let oauth: OAuth
let base: string
let port: number
let now: number
let phoneAccess: boolean

beforeEach(async () => {
  p = testProject()
  now = Date.UTC(2026, 0, 1)
  phoneAccess = true
  oauth = new OAuth(memoryStore(), undefined, () => now)
  server = new ApiServer(apiContext(p.host), { token: TOKEN, version: '0.0.0-test', oauth, publicHost: () => (phoneAccess ? PUBLIC : undefined) })
  port = await server.listen(0)
  base = `http://127.0.0.1:${port}`
})
afterEach(async () => {
  await server.close()
  p.close()
})

/** An MCP client's side of OAuth, as Claude's is: registers, is sent to sign in, keeps its tokens. */
class Provider implements OAuthClientProvider {
  readonly redirectUrl = 'https://claude.example/api/mcp/auth_callback'
  readonly clientMetadata: OAuthClientMetadata = {
    client_name: 'Claude',
    redirect_uris: [this.redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic'
  }
  info: OAuthClientInformationMixed | undefined
  saved: OAuthTokens | undefined
  verifier = ''
  signInAt: URL | undefined
  clientInformation = () => this.info
  saveClientInformation = (info: OAuthClientInformationMixed) => void (this.info = info)
  tokens = () => this.saved
  saveTokens = (tokens: OAuthTokens) => void (this.saved = tokens)
  redirectToAuthorization = (url: URL) => void (this.signInAt = url)
  saveCodeVerifier = (v: string) => void (this.verifier = v)
  codeVerifier = () => this.verifier
}

/** The sign-in page's form, sent as a browser sends it (from the page's own origin). */
const typeCode = (signin: string, code: string, origin = base) =>
  fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: new URLSearchParams({ signin, code })
  })

/** A request from the internet, as Funnel forwards it: the client's Host, and Funnel's own headers (which a client can't set). */
const FUNNEL = { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https', 'Tailscale-Funnel-Request': '?1' }
function remote(path: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: PUBLIC, ...FUNNEL, ...headers } }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString()))
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('OAuth', () => {
  it('lets the official MCP client in with the code the app shows, keeps it in with refresh tokens, and lets it be disconnected', async () => {
    const provider = new Provider()
    const url = new URL(`${base}/mcp`)
    await expect(new Client({ name: 'phone', version: '1' }).connect(new StreamableHTTPClientTransport(url, { authProvider: provider }))).rejects.toThrow(/Unauthorized/)
    // It registered itself and was sent to the sign-in page, which waits for a code shown in the app.
    expect(provider.info).toMatchObject({ client_id: expect.any(String), client_secret: expect.any(String) })
    const html = await fetch(provider.signInAt!).then((r) => r.text())
    expect(html).toContain('<b>Claude</b> (at <b>claude.example</b>) wants to read and change the universe')
    const [signIn] = oauth.pendingSignIns()
    expect(signIn).toMatchObject({ client: 'Claude', code: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/) })
    const id = /name="signin" value="([^"]+)"/.exec(html)![1]!

    // From another site, the form is turned away; a wrong code is asked again.
    expect((await typeCode(id, signIn!.code, 'https://evil.example')).status).toBe(403)
    const wrong = await typeCode(id, 'AAAA-AAAA')
    expect(wrong.status).toBe(400)
    expect(await wrong.text()).toContain('not the code Universe shows')
    // Typed in small letters without the dash, it's still the code.
    const right = await typeCode(id, signIn!.code.replace('-', '').toLowerCase())
    expect(right.status).toBe(302)
    const back = new URL(right.headers.get('location')!)
    expect(back.origin + back.pathname).toBe(provider.redirectUrl)
    expect(back.searchParams.get('state')).toBe(provider.signInAt!.searchParams.get('state'))
    expect(oauth.pendingSignIns()).toEqual([])

    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider })
    await transport.finishAuth(back.searchParams.get('code')!)
    const client = new Client({ name: 'phone', version: '1' })
    await client.connect(transport)
    expect((await client.listTools()).tools.length).toBeGreaterThan(30)
    expect(oauth.connections()).toEqual([expect.objectContaining({ name: 'Claude' })])

    // An hour on, the access token has run out: the client refreshes it by itself.
    const firstAccess = provider.saved!.access_token
    now += 2 * 60 * 60_000
    const created = await client.callTool({ name: 'create_event', arguments: { worldId: p.worldId, title: 'From the phone', start: '12' } })
    expect(created.isError).toBeFalsy()
    expect(provider.saved!.access_token).not.toBe(firstAccess)
    expect(p.project.snapshot().timeline.events.map((e) => e.title)).toEqual(['From the phone'])

    // Disconnected in the app: its tokens stop working at once, refresh token too, and a change feed it has open closes.
    const feed = (await fetch(`${base}/v1/changes`, { headers: { Authorization: `Bearer ${provider.saved!.access_token}` } })).body!.getReader()
    await feed.read()
    oauth.revoke(oauth.connections()[0]!.id)
    server.changed({ summary: 'Something private', source: 'user', at: '2026-01-01T00:00:00Z' })
    expect((await feed.read()).done).toBe(true)
    await expect(client.listTools()).rejects.toThrow()
    await client.close()
  })

  it('checks the code verifier, uses a code once, and stops a sign-in after five wrong codes', async () => {
    const registered = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Script', redirect_uris: ['http://localhost:7777/cb'], token_endpoint_auth_method: 'none' })
    }).then((r) => r.json() as Promise<{ client_id: string; client_secret?: string }>)
    expect(registered.client_secret).toBeUndefined()
    const verifier = 'v'.repeat(50)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const signInPage = (state: string) =>
      fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: 'http://localhost:7777/cb', code_challenge: challenge, code_challenge_method: 'S256', state })}`).then((r) =>
        r.text()
      )
    const signinOf = (html: string) => /name="signin" value="([^"]+)"/.exec(html)![1]!

    const id = signinOf(await signInPage('a'))
    const code = new URL((await typeCode(id, oauth.pendingSignIns()[0]!.code)).headers.get('location')!).searchParams.get('code')!
    const exchange = (code_verifier: string) =>
      fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier, client_id: registered.client_id, redirect_uri: 'http://localhost:7777/cb' })
      })
    const stolen = await exchange('x'.repeat(50))
    expect(stolen.status).toBe(400)
    expect(await stolen.json()).toMatchObject({ error: 'invalid_grant' })
    // A wrong verifier spends the code: it can't be tried again.
    expect((await exchange(verifier)).status).toBe(400)

    const other = signinOf(await signInPage('b'))
    for (let i = 0; i < 4; i++) expect((await typeCode(other, 'AAAA-AAAA')).status).toBe(400)
    expect((await typeCode(other, 'AAAA-AAAA')).status).toBe(403)
    expect(oauth.pendingSignIns()).toEqual([])

    // A sign-in for an address the client didn't register shows an error rather than sending anyone there.
    const elsewhere = await fetch(`${base}/oauth/authorize?client_id=${registered.client_id}&redirect_uri=https://evil.example/cb&response_type=code`, { redirect: 'manual' })
    expect(elsewhere.status).toBe(400)
  })

  it('ends a connection whose old refresh token is used again: two copies exist, and one isn’t the client’s', async () => {
    const { client_id } = (await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://localhost:7777/cb'], token_endpoint_auth_method: 'none' })
    }).then((r) => r.json())) as { client_id: string }
    const verifier = 'w'.repeat(50)
    const html = await fetch(
      `${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'http://localhost:7777/cb', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`
    ).then((r) => r.text())
    const signin = /name="signin" value="([^"]+)"/.exec(html)![1]!
    const code = new URL((await typeCode(signin, oauth.pendingSignIns()[0]!.code)).headers.get('location')!).searchParams.get('code')!
    const token = (params: Record<string, string>) =>
      fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id, ...params }) }).then(
        async (r) => ({ status: r.status, body: (await r.json()) as { refresh_token: string; access_token: string } })
      )
    const first = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'http://localhost:7777/cb' })
    const second = await token({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token })
    expect(second.status).toBe(200)
    expect((await token({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token })).status).toBe(400)
    // The newer one stops too: there's no telling which copy is the client's.
    expect((await token({ grant_type: 'refresh_token', refresh_token: second.body.refresh_token })).status).toBe(400)
    expect(oauth.connections()).toEqual([])
  })

  it('can’t be crowded out: limits per sender, new registrations kept, and one sender’s sign-ins never replacing another’s', async () => {
    const body = JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' })
    const registerFrom = (ip: string) => remote('/oauth/register', { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, 'POST', body)
    // One sender: 20 an hour.
    for (let i = 0; i < 20; i++) expect((await registerFrom('198.51.100.1')).status).toBe(201)
    expect((await registerFrom('198.51.100.1')).status).toBe(429)
    // Many senders fill the list; the newest registrations aren't dropped (the client may be signing in), until they're ten minutes old.
    for (let i = 0; i < 80; i++) expect((await registerFrom(`198.51.100.${2 + Math.floor(i / 20)}`)).status).toBe(201)
    expect((await registerFrom('198.51.100.9')).status).toBe(429)
    now += 11 * 60_000
    const mine = JSON.parse((await registerFrom('198.51.100.9')).body) as { client_id: string }
    expect(mine.client_id).toEqual(expect.any(String))

    const signInFrom = (ip: string) =>
      remote(
        `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: mine.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: 'c', code_challenge_method: 'S256' })}`,
        { 'X-Forwarded-For': ip }
      )
    expect((await signInFrom('203.0.113.50')).status).toBe(200)
    const users = oauth.pendingSignIns()[0]!.id
    // Another sender starting many keeps only its own two newest, and the first sender's stays.
    for (let i = 0; i < 6; i++) expect((await signInFrom('203.0.113.66')).status).toBe(200)
    expect(oauth.pendingSignIns()).toHaveLength(3)
    expect(oauth.pendingSignIns().map((x) => x.id)).toContain(users)
    // And it can't start more than ten in ten minutes.
    for (let i = 0; i < 4; i++) await signInFrom('203.0.113.66')
    expect((await signInFrom('203.0.113.66')).status).toBe(429)
  })

  it('serves the public host with https addresses and OAuth tokens only, and not at all with phone access off', async () => {
    const meta = JSON.parse((await remote('/.well-known/oauth-protected-resource/mcp')).body)
    expect(meta).toMatchObject({ resource: `https://${PUBLIC}/mcp`, authorization_servers: [`https://${PUBLIC}`] })
    const unauthorized = await remote('/v1/worlds', { Authorization: `Bearer ${TOKEN}` })
    // The app's own token is for this computer only.
    expect(unauthorized.status).toBe(401)
    expect((await remote('/v1/worlds')).status).toBe(401)
    // Through Funnel, naming this computer's own address to pass for a local request: still from the internet.
    expect((await remote('/v1/worlds', { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}` })).status).toBe(403)
    expect((await remote('/v1/worlds', { Host: `localhost:${port}`, Authorization: `Bearer ${TOKEN}` })).status).toBe(403)
    // From the internet, a client may only be sent back to Claude (or its own computer).
    const register = (uri: string) => remote('/oauth/register', { 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ client_name: 'Claude', redirect_uris: [uri] }))
    expect((await register('https://evil.example/cb')).status).toBe(400)
    expect((await register('https://claude.ai@evil.example/cb')).status).toBe(400)
    expect((await register('https://claude.ai/api/mcp/auth_callback')).status).toBe(201)
    phoneAccess = false
    expect((await remote('/.well-known/oauth-protected-resource/mcp')).status).toBe(403)
    expect((await remote('/.well-known/oauth-protected-resource/mcp', { Host: `127.0.0.1:${port}` })).status).toBe(403)
    // On this computer the token still works.
    expect((await fetch(`${base}/v1/worlds`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
  })
})

describe('the app’s own client', () => {
  it('signs in with PKCE and the code the app shows, its tokens exchanged by the app itself, and stays registered however long it goes unused', async () => {
    const callback = `${base}/signed-in`
    oauth.firstParty('universe-phone', 'Universe on your phone', [callback])
    const verifier = 'the-phone-apps-own-verifier-0123456789-abcdefghijklmnop'
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const q = new URLSearchParams({ response_type: 'code', client_id: 'universe-phone', redirect_uri: callback, code_challenge: challenge, code_challenge_method: 'S256', state: 's1' })
    const page = await (await fetch(`${base}/oauth/authorize?${q}`)).text()
    expect(page).toContain('Universe on your phone')
    const [signIn] = oauth.pendingSignIns()
    const signin = /name="signin" value="([^"]+)"/.exec(page)![1]!
    const back = new URL((await typeCode(signin, signIn!.code)).headers.get('location')!)
    expect(back.searchParams.get('state')).toBe('s1')

    const tokens = oauth.exchange({ grant_type: 'authorization_code', client_id: 'universe-phone', code: back.searchParams.get('code')!, code_verifier: verifier, redirect_uri: callback })
    expect(oauth.verify(tokens.access_token)).toBe(true)
    expect(oauth.connections().map((c) => c.name)).toEqual(['Universe on your phone'])
    expect(() => oauth.exchange({ grant_type: 'refresh_token', client_id: 'universe-phone', refresh_token: 'wrong' })).toThrow(/sign in again/)
    const fresh = oauth.exchange({ grant_type: 'refresh_token', client_id: 'universe-phone', refresh_token: tokens.refresh_token })
    expect(oauth.verify(fresh.access_token)).toBe(true)

    // Removed in the app: gone; and the client itself stays for next time.
    oauth.revoke(oauth.connections()[0]!.id)
    now += 400 * 24 * 60 * 60_000
    oauth.firstParty('universe-phone', 'Universe on your phone', [callback])
    expect(() => oauth.exchange({ grant_type: 'refresh_token', client_id: 'universe-phone', refresh_token: fresh.refresh_token })).toThrow(/sign in again/)
    expect((await fetch(`${base}/oauth/authorize?${q}`)).status).toBe(200)
  })
})
