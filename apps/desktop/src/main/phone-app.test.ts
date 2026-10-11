import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OAuth, memoryStore } from '@universe/api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toWire } from '../shared/wire'
import type { SyncVisitor } from './device-sync'
import { PhoneAppServer } from './phone-app'

const HOST = 'studio.tail1234.ts.net:8443'
const LOGIN = 'owner@example.com'
/** Someone else, with a device shared into the owner's tailnet, and a member of the universe open here. */
const MEMBER = 'bob@example.com'
/** Someone else on the tailnet who isn't. */
const STRANGER = 'mallory@example.com'
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
/** What sync was asked, by whom. */
const heard: { what: string; login: string; owner: boolean; body?: unknown }[] = []
const member = (v: SyncVisitor) => v.owner || v.login === MEMBER

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
  heard.length = 0
  appOn = syncOn = true
  server = new PhoneAppServer({
    oauth,
    appOn: () => appOn,
    sync: {
      on: () => syncOn,
      mayVisit: member,
      hello: (v, body) => (heard.push({ what: 'hello', login: v.login, owner: v.owner, body }), { device: 'here', project: member(v) ? { syncId: 's1', name: 'Aerth' } : null }),
      changes: (body, v) => (heard.push({ what: 'changes', login: v.login, owner: v.owner }), v.device === 'there' ? { status: 200, body: { rows: [], upTo: (body as { since: number }).since + 1, more: false } } : { status: 400, body: { error: 'Who?' } }),
      push: (body, v) => (heard.push({ what: 'push', login: v.login, owner: v.owner, body }), { status: 200, body: {} }),
      nudged: (body, v) => void (heard.push({ what: 'nudge', login: v.login, owner: v.owner }), nudges.push(body))
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
    // A page can't ask (it would send an Origin, and couldn't set the header without asking first); to anyone else on the tailnet, nothing is open.
    expect((await call('/sync/hello', { headers: { ...sync, origin: `https://${HOST}` } })).status).toBe(403)
    expect((await call('/sync/hello')).status).toBe(403)
    expect(JSON.parse((await call('/sync/hello', { headers: { ...sync, 'tailscale-user-login': 'someone@example.com' } })).body)).toEqual({ device: 'here', project: null })
    // With the phone app off, sync still answers, and the app doesn't.
    appOn = false
    expect((await call('/sync/hello', { headers: sync })).status).toBe(200)
    expect((await call('/')).status).toBe(403)
    syncOn = false
    expect((await call('/sync/hello', { headers: sync })).status).toBe(403)
  })

  it('answers other people only about sync, and only what syncing a universe they’re members of takes', async () => {
    const sync = { 'x-universe-sync': '1', 'x-universe-device': 'there', 'content-type': 'application/json' }
    const as = (login: string, path: string, method = 'POST', body = '{"syncId":"s1","since":0}') => call(path, { method, headers: { ...sync, 'tailscale-user-login': login }, ...(method === 'POST' && { body }) })
    const hello = async (login: string, method: string) => JSON.parse((await as(login, '/sync/hello', method, '{"syncId":"s1"}')).body) as { project: object | null }

    // A member: what's open, its changes, theirs given and a nudge; told who asks.
    expect((await hello(MEMBER, 'GET')).project).toEqual({ syncId: 's1', name: 'Aerth' })
    expect((await hello(MEMBER, 'POST')).project).toEqual({ syncId: 's1', name: 'Aerth' })
    expect(heard.at(-1)).toEqual({ what: 'hello', login: MEMBER, owner: false, body: { syncId: 's1' } })
    // However Tailscale writes a login, it's compared as members keep it: the owner's too.
    expect((await hello('Bob@Example.com', 'POST')).project).toEqual({ syncId: 's1', name: 'Aerth' })
    expect(heard.at(-1)).toMatchObject({ login: MEMBER, owner: false })
    await hello('Owner@Example.com', 'GET')
    expect(heard.at(-1)).toMatchObject({ login: LOGIN, owner: true })
    expect((await as(MEMBER, '/sync/changes')).status).toBe(200)
    expect((await as(MEMBER, '/sync/push', 'POST', JSON.stringify({ syncId: 's1', rows: [] }))).status).toBe(200)
    expect((await as(MEMBER, '/sync/nudge', 'POST', '{"host":"bobs-studio"}')).status).toBe(202)
    expect(heard.slice(-3).map((h) => [h.what, h.login, h.owner])).toEqual([['changes', MEMBER, false], ['push', MEMBER, false], ['nudge', MEMBER, false]])

    // Nothing else: not the phone app, its bridge or signing in, nor another sync path.
    for (const path of ['/', '/assets/app.js', '/manifest.webmanifest', '/oauth/authorize', '/signed-in', '/bridge/getState', '/bridge/events', '/sync/other']) {
      expect((await call(path, { headers: { 'tailscale-user-login': MEMBER } })).status, path).toBe(403)
      expect((await as(MEMBER, path)).status, path).toBe(403)
    }

    // Someone who isn't a member: nothing is open, and the rest is turned away without being asked.
    heard.length = 0
    expect((await hello(STRANGER, 'GET')).project).toBeNull()
    expect((await hello(STRANGER, 'POST')).project).toBeNull()
    for (const path of ['/sync/changes', '/sync/push', '/sync/nudge']) expect((await as(STRANGER, path)).status, path).toBe(403)
    expect(heard.map((h) => h.what)).toEqual(['hello', 'hello'])

    // Not without a login (a tagged server's), from Funnel, from a page, or without the sync header.
    expect((await call('/sync/hello', { headers: { ...sync, 'tailscale-user-login': '' } })).status).toBe(403)
    expect((await call('/sync/hello', { headers: { ...sync, 'tailscale-user-login': MEMBER, 'tailscale-funnel-request': '?1' } })).status).toBe(403)
    expect((await call('/sync/hello', { headers: { ...sync, 'tailscale-user-login': MEMBER, origin: `https://${HOST}` } })).status).toBe(403)
    expect((await call('/sync/hello', { headers: { 'tailscale-user-login': MEMBER } })).status).toBe(403)
    syncOn = false
    expect((await as(MEMBER, '/sync/hello', 'GET')).status).toBe(403)
  })

  it('takes a page of rows given at once, bigger than any other sync question', async () => {
    const sync = { 'x-universe-sync': '1', 'x-universe-device': 'there', 'content-type': 'application/json', 'tailscale-user-login': MEMBER }
    const rows = [{ key: 'asset:a', stamp: 'x', data: { name: 'a.glb', mime: 'model/gltf-binary', data: 'A'.repeat(3_000_000) } }]
    const big = JSON.stringify({ syncId: 's1', rows })
    expect((await call('/sync/push', { method: 'POST', headers: sync, body: big })).status).toBe(200)
    expect((heard.at(-1)!.body as { rows: unknown[] }).rows).toHaveLength(1)
    expect((await call('/sync/changes', { method: 'POST', headers: sync, body: big })).status).toBe(413)
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
