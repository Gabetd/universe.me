import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'
import { readText, send, writePrivate, type OAuth } from '@universe/api'
import { isRemoteMethod, type RemoteEvent, type RemoteMethod } from '../shared/api'
import { fromWire, toWire } from '../shared/wire'

/**
 * The phone app (PLAN.md §6.6): this app's own window, in the phone's
 * browser, from the computer. Listens on 127.0.0.1 only; `tailscale serve`
 * forwards the computer's tailnet name (port APP_HTTPS_PORT) here, so only
 * devices signed in to the user's tailnet reach it, and each request must
 * carry the tailnet owner's login, which Tailscale adds and a client can't.
 * A phone signs in once with the code the computer shows (the API's OAuth,
 * as its own client): the app keeps its tokens, and the phone a cookie for
 * them. The page then works as the window does, through a bridge: the same
 * methods (those `REMOTE_METHODS` allows) as HTTP calls, and its events as
 * a stream.
 */

/** The app's own OAuth client: what it's called in Connect AI's list of connections. */
export const PHONE_CLIENT_ID = 'universe-phone-app'
const PHONE_CLIENT_NAME = 'Universe on your phone'

const SESSION_COOKIE = '__Host-universe'
const LOGIN_COOKIE = '__Host-universe-login'
const SESSION_DAYS = 90
const LOGIN_TTL = 10 * 60_000
const MAX_LOGINS = 20
const MAX_BODY = 50 * 1024 * 1024

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon'
}

/** Only the app's own files and the bridge, from the page itself. */
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin'
}

const hash = (text: string) => createHash('sha256').update(text).digest('base64url')
const secret = () => randomBytes(32).toString('base64url')

/** Where the phone app is reachable: the computer's tailnet name with the port, and who may use it. */
export interface PhoneAppPlace {
  /** `name.tailnet.ts.net:8443`, as the Host the browser sends. */
  host: string
  /** The tailnet owner's login; requests from anyone else on the tailnet are turned away. */
  login: string
}

/** What the user's other devices ask (PLAN.md §6.7; device-sync.ts): what's open, its changes, and a nudge to ask for theirs. */
export interface SyncRoutes {
  on(): boolean
  hello(): object
  changes(body: unknown, device: string | undefined): { ok: true; rows: unknown[]; upTo: number; more: boolean } | { ok: false; status: number; error: string }
  nudged(body: unknown): void
}

export interface PhoneAppOptions {
  oauth: OAuth
  /** Whether the phone app itself is on (the server can be up for sync alone). */
  appOn(): boolean
  sync: SyncRoutes
  /** The window's built files (index.html and its assets). */
  files: string
  /** Where it's answered, while it's on. */
  place(): PhoneAppPlace | undefined
  /** Answers one of the window's methods. */
  answer(method: RemoteMethod, args: unknown[]): Promise<unknown>
  /** Where sessions are kept between runs (the tokens they stand for are secrets: the file is the user's alone). */
  sessionsFile: string
}

/** A signed-in phone: the tokens the app keeps for it. */
interface PhoneSession {
  access: string
  refresh: string
}

export class PhoneAppServer {
  private server: Server | undefined
  private readonly sessions: Map<string, PhoneSession>
  /** Sign-ins started, by their state, with the PKCE verifier the app holds for them. */
  private readonly logins = new Map<string, { verifier: string; expires: number }>()
  private readonly feeds = new Set<{ res: ServerResponse; session: string }>()
  private heartbeat: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: PhoneAppOptions) {
    this.sessions = loadSessions(options.sessionsFile)
  }

  listen(): Promise<number> {
    const server = createServer((req, res) => void this.serve(req, res))
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        this.server = server
        this.heartbeat = setInterval(() => this.toFeeds(': still here\n\n'), 25_000)
        this.heartbeat.unref()
        resolve((server.address() as AddressInfo).port)
      })
    })
  }

  close(): Promise<void> {
    clearInterval(this.heartbeat)
    for (const feed of this.feeds) feed.res.end()
    this.feeds.clear()
    const server = this.server
    this.server = undefined
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()))
  }

  /** Tells every phone app open now what happened. */
  push(event: RemoteEvent, value: unknown): void {
    this.toFeeds(`event: ${event}\ndata: ${toWire(value)}\n\n`)
  }

  private toFeeds(text: string): void {
    for (const feed of this.feeds) {
      // A phone signed out (removed in Connect AI) hears nothing more: checked each time, heartbeats included.
      if (this.alive(feed.session)) feed.res.write(text)
      else {
        this.feeds.delete(feed)
        feed.res.end()
      }
    }
  }

  /**
   * Who a request is from, if it may be answered: forwarded by `tailscale
   * serve` (not Funnel: never from the internet) for the computer's tailnet
   * name and from the tailnet's owner.
   */
  private reached(req: IncomingMessage): { base: string; source: string } | undefined {
    const place = this.options.place()
    if (!place || req.headers['tailscale-funnel-request'] !== undefined) return undefined
    if (req.headers.host !== place.host || req.headers['tailscale-user-login'] !== place.login) return undefined
    return { base: `https://${place.host}`, source: String(req.headers['x-forwarded-for'] ?? 'tailnet').split(',').at(-1)!.trim() }
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const at = this.reached(req)
      if (!at) return send(res, 403, { error: 'Universe on your phone is only for the devices on your own tailnet' })
      const url = new URL(req.url ?? '/', at.base)
      // From the page itself only (the sign-in form and the bridge send their Origin).
      if (req.headers.origin !== undefined && req.headers.origin !== at.base) return send(res, 403, { error: 'Requests from other pages are not allowed' })
      // Another of the user's devices (the tailnet's owner already checked), not a page: never with an Origin.
      if (url.pathname.startsWith('/sync/')) return await this.syncRoute(req, res, url.pathname)
      if (!this.options.appOn()) return send(res, 403, { error: 'Universe on your phone is turned off on this computer' })
      if (url.pathname === '/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) {
        await this.options.oauth.handle(req, res, url, at.base, { remote: true, source: at.source })
        return
      }
      if (req.method === 'GET' && url.pathname === '/signed-in') return this.signedIn(req, res, url, at.base)
      const session = this.session(req)
      if (!session) {
        if (req.method === 'GET' && !url.pathname.startsWith('/bridge/')) return this.startSignIn(res, at.base)
        return send(res, 401, { error: 'Sign in again' })
      }
      if (req.method === 'GET' && url.pathname === '/bridge/events') return this.openFeed(res, session)
      if (req.method === 'POST' && url.pathname.startsWith('/bridge/')) return await this.bridge(req, res, url.pathname.slice('/bridge/'.length))
      if (req.method === 'GET') return await this.file(res, url.pathname)
      send(res, 405, { error: 'Not here' })
    } catch (err) {
      send(res, 500, { error: (err as Error).message })
    }
  }

  private async syncRoute(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const { sync } = this.options
    if (req.headers['x-universe-sync'] !== '1' || req.headers.origin !== undefined) return send(res, 403, { error: 'For Universe on your other devices' })
    if (!sync.on()) return send(res, 403, { error: 'Sync is off on this computer' })
    const device = typeof req.headers['x-universe-device'] === 'string' ? req.headers['x-universe-device'] : undefined
    if (req.method === 'GET' && path === '/sync/hello') return send(res, 200, sync.hello())
    if (req.method !== 'POST') return send(res, 405, { error: 'Not here' })
    let body: unknown
    try {
      body = JSON.parse(await readText(req, 64 * 1024))
    } catch {
      return send(res, 400, { error: 'Send JSON' })
    }
    if (path === '/sync/changes') {
      const answer = sync.changes(body, device)
      return answer.ok ? send(res, 200, { rows: answer.rows, upTo: answer.upTo, more: answer.more }) : send(res, answer.status, { error: answer.error })
    }
    if (path === '/sync/nudge') {
      sync.nudged(body)
      return send(res, 202, {})
    }
    send(res, 404, { error: 'Not here' })
  }

  /** Sends the phone to sign in, holding the PKCE verifier and a state its cookie names. */
  private startSignIn(res: ServerResponse, base: string): void {
    const now = Date.now()
    for (const [state, login] of this.logins) if (login.expires <= now) this.logins.delete(state)
    // Too many at once: the oldest goes.
    if (this.logins.size >= MAX_LOGINS) this.logins.delete(this.logins.keys().next().value!)
    const [state, verifier] = [secret(), secret()]
    this.logins.set(state, { verifier, expires: now + LOGIN_TTL })
    const redirect = `${base}/signed-in`
    this.options.oauth.firstParty(PHONE_CLIENT_ID, PHONE_CLIENT_NAME, [redirect])
    const q = new URLSearchParams({ response_type: 'code', client_id: PHONE_CLIENT_ID, redirect_uri: redirect, code_challenge: hash(verifier), code_challenge_method: 'S256', state })
    res.writeHead(302, { Location: `/oauth/authorize?${q}`, 'Set-Cookie': cookie(LOGIN_COOKIE, state, LOGIN_TTL / 1000), 'Cache-Control': 'no-store' })
    res.end()
  }

  /** Back from signing in: the code for tokens (kept here), and a session cookie for the phone. */
  private signedIn(req: IncomingMessage, res: ServerResponse, url: URL, base: string): void {
    const state = url.searchParams.get('state') ?? ''
    const login = this.logins.get(state)
    this.logins.delete(state)
    const fail = (why: string) => send(res, 400, page('Can’t sign in', why), 'text/html; charset=utf-8')
    // The state must be the one this browser was given, and still fresh.
    if (!login || login.expires <= Date.now() || readCookie(req, LOGIN_COOKIE) !== state) return fail('This sign-in is out of date. Open Universe again to start over.')
    const code = url.searchParams.get('code')
    if (!code) return fail('Signing in was stopped. Open Universe again to start over.')
    try {
      const tokens = this.options.oauth.exchange({ grant_type: 'authorization_code', client_id: PHONE_CLIENT_ID, code, code_verifier: login.verifier, redirect_uri: `${base}/signed-in` })
      const id = secret()
      this.sessions.set(hash(id), { access: tokens.access_token, refresh: tokens.refresh_token })
      this.save()
      res.writeHead(302, { Location: '/', 'Set-Cookie': [cookie(SESSION_COOKIE, id, SESSION_DAYS * 86_400), cookie(LOGIN_COOKIE, '', 0)], 'Cache-Control': 'no-store' })
      res.end()
    } catch (err) {
      fail((err as Error).message)
    }
  }

  /** The phone's session (by its cookie's hash), if it's still signed in. */
  private session(req: IncomingMessage): string | undefined {
    const id = readCookie(req, SESSION_COOKIE)
    const key = id && hash(id)
    return key && this.alive(key) ? key : undefined
  }

  /** Whether a session is still signed in, its access renewed when it runs out; it ends once the phone is removed in Connect AI. */
  private alive(key: string): boolean {
    const session = this.sessions.get(key)
    if (!session) return false
    if (this.options.oauth.verify(session.access)) return true
    try {
      const tokens = this.options.oauth.exchange({ grant_type: 'refresh_token', client_id: PHONE_CLIENT_ID, refresh_token: session.refresh })
      this.sessions.set(key, { access: tokens.access_token, refresh: tokens.refresh_token })
      this.save()
      return true
    } catch {
      this.sessions.delete(key)
      this.save()
      return false
    }
  }

  /** One of the window's methods, its arguments and answer in the bridge's JSON. */
  private async bridge(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
    if (!isRemoteMethod(method)) return send(res, 403, { error: `${method} is for the computer itself` })
    if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'Send JSON' })
    const args = fromWire<unknown>(await readText(req, MAX_BODY))
    if (!Array.isArray(args)) return send(res, 400, { error: 'Send the arguments as a list' })
    const answer = await this.options.answer(method, args)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(toWire(answer === undefined ? null : answer))
  }

  private openFeed(res: ServerResponse, session: string): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    res.write(': connected\n\n')
    const feed = { res, session }
    this.feeds.add(feed)
    res.on('close', () => this.feeds.delete(feed))
  }

  /** One of the window's files; anything else that isn't one is the page (the app finds its way from there). */
  private async file(res: ServerResponse, pathname: string): Promise<void> {
    const root = this.options.files
    let path: string
    try {
      path = normalize(join(root, decodeURIComponent(pathname)))
    } catch {
      return send(res, 400, { error: 'Not a path' })
    }
    if (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep)) return send(res, 404, { error: 'Not here' })
    const type = TYPES[extname(path)]
    const target = type && extname(path) !== '.html' ? path : join(root, 'index.html')
    try {
      const body = await readFile(target)
      res.writeHead(200, { 'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream', 'Cache-Control': target.endsWith('index.html') ? 'no-store' : 'private, max-age=3600', ...SECURITY })
      res.end(body)
    } catch {
      send(res, 404, { error: 'Not here' })
    }
  }

  private save(): void {
    writePrivate(this.options.sessionsFile, JSON.stringify(Object.fromEntries(this.sessions)))
  }
}

function loadSessions(file: string): Map<string, PhoneSession> {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, PhoneSession>
    return new Map(Object.entries(saved).filter(([, s]) => typeof s?.access === 'string' && typeof s.refresh === 'string'))
  } catch {
    return new Map()
  }
}

/** A cookie only this site's pages send back, never to scripts, never over plain HTTP. */
const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; Max-Age=${Math.floor(maxAge)}; HttpOnly; Secure; SameSite=Strict`

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

const page = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;background:#0b0e17;color:#e8eefc;padding:24px"><h1 style="font-size:20px">${title}</h1><p>${text.replace(/[<>&]/g, '')}</p><p><a style="color:#8ab4ff" href="/">Open Universe</a></p></body></html>`
