import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJson, readText, send } from './http-io'
import { ours, writePrivate } from './private-file'

/**
 * OAuth 2.1 for MCP clients that can't be handed a token, such as a
 * claude.ai custom connector (PLAN.md §6.4): the server's metadata, dynamic
 * client registration, authorization codes with PKCE, and access and
 * refresh tokens. A client is let in by a code the app shows on the
 * computer, typed into this server's own sign-in page, so only someone who
 * can see the app's screen can connect one.
 */

const MINUTE = 60_000
const ACCESS_TTL = 60 * MINUTE
/** A connection unused this long has to sign in again. */
const REFRESH_TTL = 90 * 24 * 60 * MINUTE
const SIGN_IN_TTL = 10 * MINUTE
const CODE_TTL = MINUTE
const TRIES_PER_SIGN_IN = 5
/** Wrong codes allowed an hour, across all sign-ins, so codes can't be guessed by starting sign-ins over and over. */
const WRONG_PER_HOUR = 30
const MAX_SIGN_INS = 5
const MAX_CLIENTS = 100
/** A registered client that never signed in is forgotten after a day. */
const UNUSED_CLIENT_TTL = 24 * 60 * MINUTE
const MAX_BODY = 64 * 1024
/** Codes to type: no 0/O, 1/I/L or U. */
const CODE_LETTERS = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

export interface OAuthClient {
  id: string
  name: string
  redirectUris: string[]
  /** Hashed; none for a public client. */
  secretHash?: string
  created: number
}

/** A connected client: its tokens (hashed) and when it was last used. */
export interface OAuthGrant {
  id: string
  clientId: string
  name: string
  created: number
  lastUsed: number
  accessHash: string
  accessExpires: number
  refreshHash: string
  refreshExpires: number
}

export interface OAuthData {
  clients: OAuthClient[]
  grants: OAuthGrant[]
}

/** Where clients and grants are kept between runs. */
export interface OAuthStore {
  load(): OAuthData
  save(data: OAuthData): void
}

/** A sign-in waiting for its code: what the app shows. */
export interface SignIn {
  id: string
  client: string
  /** To type on the sign-in page, as "ABCD-EFGH". */
  code: string
  expires: number
}

/** A connected client, as the app lists it. */
export interface Connection {
  id: string
  name: string
  created: number
  lastUsed: number
}

interface PendingSignIn extends SignIn {
  clientId: string
  redirectUri: string
  state?: string
  challenge: string
  tries: number
}

interface IssuedCode {
  clientId: string
  redirectUri: string
  challenge: string
  expires: number
}

const hash = (text: string) => createHash('sha256').update(text).digest('base64url')
const secret = () => randomBytes(32).toString('base64url')
/** Compares secrets in a time that doesn't tell how much matched. */
export const sameText = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)]
  return x.length === y.length && timingSafeEqual(x, y)
}
const newCode = () => {
  const letters = Array.from({ length: 8 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)])
  return `${letters.slice(0, 4).join('')}-${letters.slice(4).join('')}`
}
/** A typed code as it's compared: capitals, without spaces or dashes. */
const typed = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, '')

/** Clients and grants in a file only this user can read; an unreadable or someone else's file counts as empty. */
export function fileStore(path: string): OAuthStore {
  return {
    load: () => {
      try {
        if (!ours(path)) return { clients: [], grants: [] }
        const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<OAuthData>
        return { clients: data.clients ?? [], grants: data.grants ?? [] }
      } catch {
        return { clients: [], grants: [] }
      }
    },
    save: (data) => writePrivate(path, JSON.stringify(data))
  }
}

export const memoryStore = (): OAuthStore => {
  let data: OAuthData = { clients: [], grants: [] }
  return { load: () => structuredClone(data), save: (d) => (data = structuredClone(d)) }
}

/** An error the token and registration endpoints answer as OAuth says: a code and what's wrong. */
class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export class OAuth {
  private data: OAuthData
  private readonly signIns = new Map<string, PendingSignIn>()
  /** Authorization codes, by their hash, until they're exchanged. */
  private readonly codes = new Map<string, IssuedCode>()
  private wrong: number[] = []

  /** `changed` is called when sign-ins or connections come or go. */
  constructor(
    private readonly store: OAuthStore,
    private readonly changed: () => void = () => {},
    private readonly now: () => number = Date.now
  ) {
    this.data = store.load()
    this.prune()
  }

  /** Sign-ins waiting for their code, oldest first. */
  pendingSignIns(): SignIn[] {
    const now = this.now()
    return [...this.signIns.values()].filter((s) => s.expires > now).map(({ id, client, code, expires }) => ({ id, client, code, expires }))
  }

  connections(): Connection[] {
    return this.data.grants.map(({ id, name, created, lastUsed }) => ({ id, name, created, lastUsed }))
  }

  /** Turns a sign-in down: its page then says it has expired. */
  deny(signInId: string): void {
    if (this.signIns.delete(signInId)) this.changed()
  }

  /** Disconnects a client: its tokens stop working at once. */
  revoke(grantId: string): void {
    const before = this.data.grants.length
    this.data.grants = this.data.grants.filter((g) => g.id !== grantId)
    if (this.data.grants.length !== before) this.commit()
  }

  /** Whether an access token is one this server gave and still good. */
  verify(token: string): boolean {
    const now = this.now()
    const key = hash(token)
    const grant = this.data.grants.find((g) => g.accessHash === key)
    if (!grant || grant.accessExpires <= now) return false
    // Saved at most once a minute: it's only for the list of connections.
    if (now - grant.lastUsed > MINUTE) {
      grant.lastUsed = now
      this.store.save(this.data)
    }
    return true
  }

  /** The routes OAuth adds, if `url` is one of them; `base` is the server's address as the client reached it. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, base: string): Promise<boolean> {
    const route = `${req.method} ${url.pathname}`
    try {
      switch (route) {
        case 'GET /.well-known/oauth-protected-resource':
        case 'GET /.well-known/oauth-protected-resource/mcp':
          send(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], resource_name: 'Universe' })
          return true
        case 'GET /.well-known/oauth-authorization-server':
          send(res, 200, metadata(base))
          return true
        case 'POST /oauth/register':
          send(res, 201, this.register((await readJson(req, MAX_BODY)) as Record<string, unknown>))
          return true
        case 'GET /oauth/authorize':
          this.authorize(res, url.searchParams, base)
          return true
        case 'POST /oauth/authorize':
          this.signIn(res, new URLSearchParams(await readText(req, MAX_BODY)), base)
          return true
        case 'POST /oauth/token':
          send(res, 200, this.token(await readParams(req), req.headers.authorization))
          return true
        case 'POST /oauth/revoke':
          this.revokeToken((await readParams(req)).get('token') ?? '')
          send(res, 200, {})
          return true
        default:
          return false
      }
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err
      if (err.status === 401) res.setHeader('WWW-Authenticate', 'Basic')
      send(res, err.status, { error: err.code, error_description: err.message })
      return true
    }
  }

  /** Dynamic client registration (RFC 7591). */
  private register(body: Record<string, unknown>): object {
    const uris = body.redirect_uris
    if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === 'string' && redirectAllowed(u))) {
      throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uris must be https addresses (or http on this computer)')
    }
    const method = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'client_secret_basic'
    if (!['none', 'client_secret_basic', 'client_secret_post'].includes(method)) throw new OAuthError(400, 'invalid_client_metadata', `token_endpoint_auth_method ${method} isn’t supported`)
    const clientSecret = method === 'none' ? undefined : secret()
    const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'An MCP client'
    const client: OAuthClient = { id: secret(), name, redirectUris: uris as string[], created: this.now(), ...(clientSecret && { secretHash: hash(clientSecret) }) }
    this.prune()
    if (this.data.clients.length >= MAX_CLIENTS) throw new OAuthError(400, 'invalid_client_metadata', 'Too many clients are registered; try again tomorrow')
    this.data.clients.push(client)
    this.store.save(this.data)
    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.created / 1000),
      ...(clientSecret && { client_secret: clientSecret, client_secret_expires_at: 0 }),
      client_name: name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    }
  }

  /** The sign-in page: checks the request, then asks for the code the app shows. */
  private authorize(res: ServerResponse, q: URLSearchParams, base: string): void {
    const client = this.data.clients.find((c) => c.id === q.get('client_id'))
    const redirectUri = q.get('redirect_uri') ?? (client?.redirectUris.length === 1 ? client.redirectUris[0] : undefined)
    // Without a known client and one of its addresses there's nowhere safe to send an error.
    if (!client || !redirectUri || !client.redirectUris.includes(redirectUri)) return page(res, 400, 'Can’t sign in', '<p>This sign-in link isn’t one Universe knows. Start again from your AI app.</p>')
    const fail = (error: string, description: string) => redirect(res, redirectUri, { error, error_description: description, state: q.get('state'), iss: base })
    if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported')
    const challenge = q.get('code_challenge')
    if (!challenge || q.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required')
    const resource = q.get('resource')
    if (resource && !resource.startsWith(base)) return fail('invalid_target', `This server is ${base}/mcp`)
    if (this.pendingSignIns().length >= MAX_SIGN_INS) return page(res, 429, 'Too many sign-ins', '<p>Too many sign-ins are waiting. Try again in a few minutes.</p>')
    const signIn: PendingSignIn = { id: secret(), client: client.name, code: newCode(), expires: this.now() + SIGN_IN_TTL, clientId: client.id, redirectUri, challenge, tries: 0, ...(q.has('state') && { state: q.get('state')! }) }
    this.signIns.set(signIn.id, signIn)
    // Gone from the app's list when it expires.
    setTimeout(() => this.deny(signIn.id), SIGN_IN_TTL).unref()
    this.changed()
    codePage(res, 200, signIn)
  }

  /** The code typed on the sign-in page: if it's right, back to the client with an authorization code. */
  private signIn(res: ServerResponse, form: URLSearchParams, base: string): void {
    const now = this.now()
    const signIn = this.signIns.get(form.get('signin') ?? '')
    if (!signIn || signIn.expires <= now) return page(res, 410, 'Sign-in expired', '<p>This sign-in has expired or was turned down in Universe. Start again from your AI app.</p>')
    this.wrong = this.wrong.filter((t) => now - t < 60 * MINUTE)
    if (this.wrong.length >= WRONG_PER_HOUR) return page(res, 429, 'Too many tries', '<p>Too many wrong codes have been typed. Try again in an hour.</p>')
    if (!sameText(typed(form.get('code') ?? ''), typed(signIn.code))) {
      this.wrong.push(now)
      if (++signIn.tries >= TRIES_PER_SIGN_IN) {
        this.deny(signIn.id)
        return page(res, 403, 'Sign-in stopped', '<p>That was the wrong code too many times. Start again from your AI app.</p>')
      }
      return codePage(res, 400, signIn, 'That’s not the code Universe shows. Try again.')
    }
    this.deny(signIn.id)
    const code = secret()
    for (const [key, old] of this.codes) if (old.expires <= now) this.codes.delete(key)
    this.codes.set(hash(code), { clientId: signIn.clientId, redirectUri: signIn.redirectUri, challenge: signIn.challenge, expires: now + CODE_TTL })
    redirect(res, signIn.redirectUri, { code, state: signIn.state, iss: base })
  }

  /** The token endpoint: an authorization code or a refresh token for new tokens. */
  private token(params: URLSearchParams, authorization: string | undefined): object {
    const client = this.client(params, authorization)
    const now = this.now()
    if (params.get('grant_type') === 'authorization_code') {
      const key = hash(params.get('code') ?? '')
      const issued = this.codes.get(key)
      this.codes.delete(key)
      if (!issued || issued.expires <= now || issued.clientId !== client.id) throw new OAuthError(400, 'invalid_grant', 'The authorization code is wrong, used or expired')
      const redirectUri = params.get('redirect_uri')
      if (redirectUri !== null && redirectUri !== issued.redirectUri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri isn’t the one the code was given for')
      if (hash(params.get('code_verifier') ?? '') !== issued.challenge) throw new OAuthError(400, 'invalid_grant', 'The code_verifier doesn’t match the code_challenge')
      const grant: OAuthGrant = { id: secret(), clientId: client.id, name: client.name, created: now, lastUsed: now, accessHash: '', accessExpires: 0, refreshHash: '', refreshExpires: 0 }
      this.data.grants.push(grant)
      return this.issue(grant)
    }
    if (params.get('grant_type') === 'refresh_token') {
      const grant = this.data.grants.find((g) => g.refreshHash === hash(params.get('refresh_token') ?? '') && g.clientId === client.id)
      if (!grant || grant.refreshExpires <= now) throw new OAuthError(400, 'invalid_grant', 'The refresh token is wrong or expired; sign in again')
      return this.issue(grant)
    }
    throw new OAuthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token')
  }

  /** New access and refresh tokens for a grant (the old ones stop working). */
  private issue(grant: OAuthGrant): object {
    const now = this.now()
    const [access, refresh] = [secret(), secret()]
    Object.assign(grant, { lastUsed: now, accessHash: hash(access), accessExpires: now + ACCESS_TTL, refreshHash: hash(refresh), refreshExpires: now + REFRESH_TTL })
    this.commit()
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh }
  }

  /** The client calling the token endpoint, with its secret checked if it has one (from Basic auth or the form). */
  private client(params: URLSearchParams, authorization: string | undefined): OAuthClient {
    let [id, given] = [params.get('client_id'), params.get('client_secret')]
    const basic = /^Basic (.+)$/i.exec(authorization ?? '')?.[1]
    if (basic) {
      const [user, pass] = Buffer.from(basic, 'base64').toString('utf8').split(':')
      ;[id, given] = [decodeURIComponent(user ?? ''), decodeURIComponent(pass ?? '')]
    }
    const client = this.data.clients.find((c) => c.id === id)
    if (!client) throw new OAuthError(401, 'invalid_client', 'Unknown client: register again')
    if (client.secretHash && !sameText(hash(given ?? ''), client.secretHash)) throw new OAuthError(401, 'invalid_client', 'Wrong client secret')
    return client
  }

  /** Token revocation (RFC 7009): a client disconnecting itself. */
  private revokeToken(token: string): void {
    const h = hash(token)
    const grant = this.data.grants.find((g) => g.accessHash === h || g.refreshHash === h)
    if (grant) this.revoke(grant.id)
  }

  /** Drops expired grants, and clients that never signed in and are a day old. */
  private prune(): void {
    const now = this.now()
    this.data.grants = this.data.grants.filter((g) => g.refreshExpires > now)
    const used = new Set(this.data.grants.map((g) => g.clientId))
    this.data.clients = this.data.clients.filter((c) => used.has(c.id) || now - c.created < UNUSED_CLIENT_TTL)
  }

  private commit(): void {
    this.prune()
    this.store.save(this.data)
    this.changed()
  }
}

const metadata = (base: string) => ({
  issuer: base,
  authorization_endpoint: `${base}/oauth/authorize`,
  token_endpoint: `${base}/oauth/token`,
  registration_endpoint: `${base}/oauth/register`,
  revocation_endpoint: `${base}/oauth/revoke`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
  revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
  authorization_response_iss_parameter_supported: true
})

/** A client may be sent back to an https address, or to http on its own computer (as Claude Code's sign-in is). */
function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri)
    return !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
  } catch {
    return false
  }
}

/** The token and revocation endpoints' form (OAuth's own encoding; JSON is taken too). */
async function readParams(req: IncomingMessage): Promise<URLSearchParams> {
  const text = await readText(req, MAX_BODY)
  if (!req.headers['content-type']?.includes('json')) return new URLSearchParams(text)
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    return new URLSearchParams(Object.entries(body).filter(([, v]) => typeof v === 'string') as [string, string][])
  } catch {
    throw new OAuthError(400, 'invalid_request', 'The body is not JSON')
  }
}

function redirect(res: ServerResponse, to: string, params: Record<string, string | null | undefined>): void {
  const url = new URL(to)
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v)
  res.writeHead(302, { Location: url.href, 'Cache-Control': 'no-store' })
  res.end()
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f5f2; --panel: #fff; --text: #1d1d1f; --muted: #6b6b70; --accent: #4b6bfb; --bad: #c0392b; }
@media (prefers-color-scheme: dark) { :root { --bg: #121216; --panel: #1c1c22; --text: #ececf1; --muted: #9a9aa4; --accent: #7b93ff; --bad: #ff6b5b; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
main { width: 100%; max-width: 380px; background: var(--panel); border-radius: 14px; padding: 24px; box-shadow: 0 2px 16px rgb(0 0 0 / 0.08); }
h1 { font-size: 1.25rem; margin: 0 0 8px; }
p { margin: 0 0 12px; color: var(--muted); }
p b { color: var(--text); }
input { width: 100%; font: 600 1.5rem/1 ui-monospace, monospace; letter-spacing: 0.15em; text-align: center; text-transform: uppercase; padding: 12px; border: 1px solid var(--muted); border-radius: 8px; background: transparent; color: var(--text); }
button { width: 100%; margin-top: 12px; padding: 12px; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 8px; cursor: pointer; }
.error { color: var(--bad); }
`

function page(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // Nothing from elsewhere, no scripts, and not inside another site's frame.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin'
  })
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Universe</title><style>${STYLE}</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`
  )
}

function codePage(res: ServerResponse, status: number, signIn: PendingSignIn, error?: string): void {
  page(
    res,
    status,
    'Connect to Universe',
    `<p><b>${escapeHtml(signIn.client)}</b> wants to read and change the universe open in Universe on your computer.</p>
<p>To let it, type the code Universe shows on your computer (in Connect AI).</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="signin" value="${escapeHtml(signIn.id)}">
<input name="code" aria-label="Code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="XXXX-XXXX" required autofocus>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<button type="submit">Connect</button>
</form>`
  )
}
