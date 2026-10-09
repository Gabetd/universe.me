import { execFile, execFileSync } from 'node:child_process'
import type { TailscaleState } from '../shared/api'

/**
 * Tailscale on this computer, for phone access (PLAN.md §6.4): whether it's
 * there and signed in, this computer's name on the tailnet, and Funnel, which
 * gives that name a public HTTPS address forwarding to a port on 127.0.0.1.
 * The app only runs the user's own `tailscale` command; it bundles and
 * contacts nothing itself.
 */

/** Where the command is, by system (the Mac app keeps it inside its bundle). */
const PLACES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale'],
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe', 'tailscale']
}

class TailscaleError extends Error {
  constructor(
    message: string,
    readonly missing = false
  ) {
    super(message)
  }
}

let found: string | undefined

/**
 * The commands to try for `args`: each place Tailscale may be, or
 * `UNIVERSE_TAILSCALE`, another command to run instead (a .js or .mjs file
 * there is run with this app's own Node: the tests' stand-in).
 */
function commands(args: string[]): { file: string; args: string[]; env: Record<string, string> }[] {
  const override = process.env.UNIVERSE_TAILSCALE
  if (override && /\.m?js$/.test(override)) return [{ file: process.execPath, args: [override, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } }]
  if (override) return [{ file: override, args, env: {} }]
  return (found ? [found] : (PLACES[process.platform] ?? ['tailscale'])).map((file) => ({ file, args, env: {} }))
}

/** Runs `tailscale` with `args`, resolving to what it printed. */
async function tailscale(args: string[]): Promise<string> {
  for (const c of commands(args)) {
    try {
      const out = await run(c.file, c.args, c.env)
      if (!process.env.UNIVERSE_TAILSCALE) found = c.file
      return out
    } catch (err) {
      if (!(err instanceof TailscaleError && err.missing)) throw err
    }
  }
  throw new TailscaleError('Tailscale isn’t installed', true)
}

function run(file: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20_000, windowsHide: true, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
      reject(new TailscaleError(missing ? 'Tailscale isn’t installed' : (stderr.trim() || stdout.trim() || err.message), missing))
    })
  })
}

/** Where the phone app is on the tailnet: this HTTPS port of the computer's name, forwarded by `tailscale serve` (PLAN.md §6.6). */
export const APP_HTTPS_PORT = 8443

/** From `tailscale status --json`: whether it's running, this computer's name (without the root dot), and who's signed in. */
export function readStatus(json: string): { running: boolean; backend: string; host?: string; login?: string } {
  const s = JSON.parse(json) as { BackendState?: string; Self?: { DNSName?: string; UserID?: number }; User?: Record<string, { LoginName?: string }> }
  const host = s.Self?.DNSName?.replace(/\.$/, '')
  const login = s.Self?.UserID === undefined ? undefined : s.User?.[String(s.Self.UserID)]?.LoginName
  return { running: s.BackendState === 'Running', backend: s.BackendState ?? 'unknown', ...(host && { host }), ...(login && { login }) }
}

type ServeConfig = { AllowFunnel?: Record<string, boolean>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }

/** From `tailscale serve status --json`: the port on this computer that `host`'s HTTPS port `https` forwards to, if it does (on the internet too, through Funnel, or only the tailnet). */
function proxiedPort(json: string, host: string, https: number, funnel: boolean): number | null {
  const config = JSON.parse(json.trim() || '{}') as ServeConfig
  const at = `${host}:${https}`
  if (!!config.AllowFunnel?.[at] !== funnel) return null
  const proxy = config.Web?.[at]?.Handlers?.['/']?.Proxy ?? ''
  const port = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/.exec(proxy)?.[1]
  return port ? Number(port) : null
}

/** The port Funnel forwards `host`'s public HTTPS address to, if it does. */
export const funnelPort = (json: string, host: string) => proxiedPort(json, host, 443, true)

/** The port the phone app's tailnet-only address forwards to, if it does. */
export const appPort = (json: string, host: string) => proxiedPort(json, host, APP_HTTPS_PORT, false)

/** Tailscale's state on this computer, as phone access needs it. */
export async function tailscaleState(): Promise<TailscaleState> {
  try {
    // Both at once; Serve's (and Funnel's) answer only counts once Tailscale says it's running.
    const [statusJson, funnelJson] = await Promise.all([tailscale(['status', '--json']), tailscale(['serve', 'status', '--json']).catch(() => '')])
    const status = readStatus(statusJson)
    if (!status.running || !status.host) return { kind: 'stopped', detail: status.backend === 'NeedsLogin' ? 'Tailscale isn’t signed in' : 'Tailscale isn’t running' }
    return { kind: 'ready', host: status.host, ...(status.login && { login: status.login }), funnelPort: funnelPort(funnelJson, status.host), appPort: appPort(funnelJson, status.host) }
  } catch (err) {
    if (err instanceof TailscaleError && err.missing) return { kind: 'missing' }
    return { kind: 'stopped', detail: (err as Error).message }
  }
}

/** Points Funnel's public address (port 443) at `port` on this computer, or turns it off (null). Its error says what Tailscale wants, such as Funnel enabled for the tailnet. */
export async function setFunnel(port: number | null): Promise<void> {
  await tailscale(port === null ? ['funnel', '--yes', '--https=443', 'off'] : ['funnel', '--bg', '--yes', String(port)])
}

/** Points the phone app's tailnet address (`APP_HTTPS_PORT`, never on the internet) at `port` on this computer, or turns it off (null). */
export async function setServe(port: number | null): Promise<void> {
  await tailscale(port === null ? ['serve', '--yes', `--https=${APP_HTTPS_PORT}`, 'off'] : ['serve', '--bg', '--yes', `--https=${APP_HTTPS_PORT}`, `http://127.0.0.1:${port}`])
}

const FUNNEL_OFF = ['funnel', '--yes', '--https=443', 'off']
const SERVE_OFF = ['serve', '--yes', `--https=${APP_HTTPS_PORT}`, 'off']

/** Turns Funnel and the phone app's address off before the app quits: at once, as the process may end before anything async finishes, and only briefly waited for. */
export function offNow({ funnel, serve }: { funnel: boolean; serve: boolean }): void {
  for (const args of [...(funnel ? [FUNNEL_OFF] : []), ...(serve ? [SERVE_OFF] : [])]) {
    for (const c of commands(args)) {
      try {
        execFileSync(c.file, c.args, { timeout: 3000, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...c.env } })
        break
      } catch {
        // Not there, or it didn't answer in time: try the next place, or leave it.
      }
    }
  }
}
