import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OAuth, memoryStore } from '@universe/api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toWire } from '../shared/wire'
import { PhoneAppServer } from './phone-app'

const HOST = 'studio.tail1234.ts.net:8443'
const LOGIN = 'owner@example.com'
/** What `tailscale serve` adds for a device on the tailnet. */
const TAILNET = { host: HOST, 'x-forwarded-for': '100.101.102.103', 'tailscale-user-login': LOGIN }

let dir: string
let oauth: OAuth
let server: PhoneAppServer
let port: number
const asked: string[] = []
let appOn = true
let syncOn = true
const nudges: unknown[] = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'universe-phone-'))
  mkdirSync(join(dir, 'app', 'assets'), { recursive: true })
  writeFileSync(join(dir, 'app', 'index.html'), '<!doctype html><title>Universe</title>')
  writeFileSync(join(dir, 'app', 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(dir, 'app', 'manifest.webmanifest'), '{"name":"Universe"}')
  writeFileSync(join(dir, 'app', 'icon-192.png'), 'png')
  writeFileSync(join(dir, 'secret.txt'), 'not for the phone')
  oauth = new OAuth(memoryStore())
  asked.length = 0
  nudges.length = 0
  appOn = syncOn = true
  server = new PhoneAppServer({
    oauth,
    appOn: () => appOn,
    sync: {
      on: () => syncOn,
      hello: () => ({ device: 'here', project: { syncId: 's1', name: 'Aerth' } }),
      changes: (body, device) => (device === 'there' ? { status: 200, body: { rows: [], upTo: (body as { since: number }).since + 1, more: false } } : { status: 400, body: { error: 'Who?' } }),
      nudged: (body) => void nudges.push(body)
    },
    files: join(dir, 'app'),
    place: () => ({ host: HOST, login: LOGIN }),
    answer: async (method, args) => (asked.push(method), { ok: true, value: { method, args } }),
    sessionsFile: join(dir, 'sessions.json')
  })
  port = await server.listen()
})
afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function call(path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { ...TAILNET, ...headers } }, (res) => {
      let text = ''
      res.on('data', (c: Buffer) => (text += c.toString()))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const cookieOf = (answer: Answer, name: string) => ([answer.headers['set-cookie']].flat().find((c) => c?.startsWith(`${name}=`)) ?? '').split(';')[0]!

/** Signs a phone in as a person would: opened, sent to sign in, the computer's code typed, back with a cookie. */
async function signIn(): Promise<string> {
  const start = await call('/')
  expect(start.status).toBe(302)
  const login = cookieOf(start, '__Host-universe-login')
  const signInPage = await call(start.headers.location as string, { headers: { cookie: login } })
  const signin = /name="signin" value="([^"]+)"/.exec(signInPage.body)![1]!
  const code = oauth.pendingSignIns()[0]!.code
  const typed = await call('/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `https://${HOST}`, cookie: login },
    body: new URLSearchParams({ signin, code }).toString()
  })
  const back = new URL(typed.headers.location as string)
  expect(back.origin).toBe(`https://${HOST}`)
  const done = await call(`${back.pathname}${back.search}`, { headers: { cookie: login } })
  expect(done.status).toBe(302)
  return cookieOf(done, '__Host-universe')
}

const bridge = (cookie: string, method: string, args: unknown[] = [], origin = `https://${HOST}`) =>
  call(`/bridge/${method}`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: toWire(args) })

describe('the phone app’s server', () => {
  it('answers only the tailnet’s owner, through tailscale serve, never Funnel', async () => {
    expect((await call('/', { headers: { 'tailscale-user-login': 'someone@example.com' } })).status).toBe(403)
    expect((await call('/', { headers: { host: 'studio.tail1234.ts.net' } })).status).toBe(403)
    expect((await call('/', { headers: { 'tailscale-funnel-request': '?1' } })).status).toBe(403)
    expect((await call('/', { headers: { origin: 'https://evil.example' } })).status).toBe(403)
  })

  it('signs a phone in with the computer’s code, then serves the app and the methods a phone may ask', async () => {
    // Before signing in: only the way to sign in.
    expect((await call('/assets/app.js')).status).toBe(302)
    expect((await bridge('', 'getState')).status).toBe(401)
    const cookie = await signIn()
    expect(oauth.connections().map((c) => c.name)).toEqual(['Universe on your phone'])

    const page = await call('/', { headers: { cookie } })
    expect(page.body).toContain('<title>Universe</title>')
    expect(page.headers['content-security-policy']).toContain("default-src 'self'")
    expect((await call('/assets/app.js', { headers: { cookie } })).headers['content-type']).toContain('javascript')
    // Nothing outside the app's own files, however the path is written.
    expect((await call('/%2e%2e/secret.txt', { headers: { cookie } })).body).not.toContain('not for the phone')
    expect((await call('/../secret.txt', { headers: { cookie } })).body).not.toContain('not for the phone')

    const answer = await bridge(cookie, 'execute', [{ type: 'node.update', payload: { id: 'x', patch: { name: 'y' } } }])
    expect(JSON.parse(answer.body)).toEqual({ ok: true, value: { method: 'execute', args: [{ type: 'node.update', payload: { id: 'x', patch: { name: 'y' } } }] } })
    // What's for the computer only, and the bridge from another page, are turned away.
    expect((await bridge(cookie, 'apiStatus')).status).toBe(403)
    expect((await bridge(cookie, 'openProject', ['/etc/passwd'])).status).toBe(403)
    expect((await bridge(cookie, 'getState', [], 'https://evil.example')).status).toBe(403)
    expect(asked).toEqual(['execute'])
  })

  it('lets a phone add the app to its home screen before signing in, and nothing more', async () => {
    const manifest = await call('/manifest.webmanifest')
    expect(manifest.status).toBe(200)
    expect(manifest.headers['content-type']).toBe('application/manifest+json')
    expect(JSON.parse(manifest.body)).toEqual({ name: 'Universe' })
    expect((await call('/icon-192.png')).headers['content-type']).toBe('image/png')
    // Still only for the tailnet's owner, and the rest of the app still needs signing in.
    expect((await call('/manifest.webmanifest', { headers: { 'tailscale-user-login': 'someone@example.com' } })).status).toBe(403)
    expect((await call('/assets/app.js')).status).toBe(302)
  })

  it('a sign-in comes back only to the browser that started it', async () => {
    const start = await call('/')
    const login = cookieOf(start, '__Host-universe-login')
    const signInPage = await call(start.headers.location as string, { headers: { cookie: login } })
    const signin = /name="signin" value="([^"]+)"/.exec(signInPage.body)![1]!
    const typed = await call('/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `https://${HOST}` },
      body: new URLSearchParams({ signin, code: oauth.pendingSignIns()[0]!.code }).toString()
    })
    const back = new URL(typed.headers.location as string)
    // Someone else's browser (without the cookie the sign-in set) gets nothing from the code.
    expect((await call(`${back.pathname}${back.search}`)).status).toBe(400)
  })

  it('answers the user’s other devices about sync, not pages, and only while sync is on', async () => {
    const sync = { 'x-universe-sync': '1', 'x-universe-device': 'there', 'content-type': 'application/json' }
    expect(JSON.parse((await call('/sync/hello', { headers: sync })).body)).toEqual({ device: 'here', project: { syncId: 's1', name: 'Aerth' } })
    expect(JSON.parse((await call('/sync/changes', { method: 'POST', headers: sync, body: JSON.stringify({ syncId: 's1', since: 4 }) })).body)).toEqual({ rows: [], upTo: 5, more: false })
    expect((await call('/sync/nudge', { method: 'POST', headers: sync, body: JSON.stringify({ host: 'laptop' }) })).status).toBe(202)
    expect(nudges).toEqual([{ host: 'laptop' }])
    // A page can't ask (it would send an Origin, and couldn't set the header without asking first); nor anyone else on the tailnet.
    expect((await call('/sync/hello', { headers: { ...sync, origin: `https://${HOST}` } })).status).toBe(403)
    expect((await call('/sync/hello')).status).toBe(403)
    expect((await call('/sync/hello', { headers: { ...sync, 'tailscale-user-login': 'someone@example.com' } })).status).toBe(403)
    // With the phone app off, sync still answers, and the app doesn't.
    appOn = false
    expect((await call('/sync/hello', { headers: sync })).status).toBe(200)
    expect((await call('/')).status).toBe(403)
    syncOn = false
    expect((await call('/sync/hello', { headers: sync })).status).toBe(403)
  })

  it('stops a phone removed in Connect AI at once: its requests and its stream of changes', async () => {
    const cookie = await signIn()
    const heard: string[] = []
    const stream = request({ host: '127.0.0.1', port, path: '/bridge/events', headers: { ...TAILNET, cookie } })
    const ended = new Promise<void>((resolve) => {
      stream.on('response', (res) => {
        res.on('data', (c: Buffer) => heard.push(c.toString()))
        res.on('end', resolve)
      })
    })
    stream.end()
    await expect.poll(() => heard.join('')).toContain('connected')
    server.push('state', { nodes: [] })
    await expect.poll(() => heard.join('')).toContain('event: state')

    oauth.revoke(oauth.connections()[0]!.id)
    server.push('state', { nodes: ['secret'] })
    await ended
    expect(heard.join('')).not.toContain('secret')
    expect((await bridge(cookie, 'getState')).status).toBe(401)
  })
})
