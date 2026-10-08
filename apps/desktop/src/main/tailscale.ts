import { execFile } from 'node:child_process'
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

interface Ran {
  out: string
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
 * Runs `tailscale` with `args`. `UNIVERSE_TAILSCALE` names another command to
 * run instead; a .js or .mjs file there is run with this app's own Node (the
 * tests' stand-in).
 */
async function tailscale(args: string[]): Promise<Ran> {
  const override = process.env.UNIVERSE_TAILSCALE
  if (override) {
    const script = /\.m?js$/.test(override)
    return run(script ? process.execPath : override, script ? [override, ...args] : args, script ? { ELECTRON_RUN_AS_NODE: '1' } : {})
  }
  for (const place of found ? [found] : (PLACES[process.platform] ?? ['tailscale'])) {
    try {
      const ran = await run(place, args)
      found = place
      return ran
    } catch (err) {
      if (!(err instanceof TailscaleError && err.missing)) throw err
    }
  }
  throw new TailscaleError('Tailscale isn’t installed', true)
}

function run(file: string, args: string[], env: Record<string, string> = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20_000, windowsHide: true, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (!err) return resolve({ out: stdout })
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
      reject(new TailscaleError(missing ? 'Tailscale isn’t installed' : (stderr.trim() || stdout.trim() || err.message), missing))
    })
  })
}

/** From `tailscale status --json`: whether it's running, and this computer's name (without the root dot). */
export function readStatus(json: string): { running: boolean; backend: string; host?: string } {
  const s = JSON.parse(json) as { BackendState?: string; Self?: { DNSName?: string } }
  const host = s.Self?.DNSName?.replace(/\.$/, '')
  return { running: s.BackendState === 'Running', backend: s.BackendState ?? 'unknown', ...(host && { host }) }
}

/** From `tailscale funnel status --json`: the port on this computer Funnel forwards `host`'s public HTTPS address to, if it does. */
export function funnelPort(json: string, host: string): number | null {
  const config = JSON.parse(json.trim() || '{}') as { AllowFunnel?: Record<string, boolean>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }
  const at = `${host}:443`
  if (!config.AllowFunnel?.[at]) return null
  const proxy = config.Web?.[at]?.Handlers?.['/']?.Proxy ?? ''
  const port = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/.exec(proxy)?.[1]
  return port ? Number(port) : null
}

/** Tailscale's state on this computer, as phone access needs it. */
export async function tailscaleState(): Promise<TailscaleState> {
  try {
    const status = readStatus((await tailscale(['status', '--json'])).out)
    if (!status.running || !status.host) return { kind: 'stopped', detail: status.backend === 'NeedsLogin' ? 'Tailscale isn’t signed in' : 'Tailscale isn’t running' }
    return { kind: 'ready', host: status.host, funnelPort: funnelPort((await tailscale(['funnel', 'status', '--json'])).out, status.host) }
  } catch (err) {
    if (err instanceof TailscaleError && err.missing) return { kind: 'missing' }
    return { kind: 'stopped', detail: (err as Error).message }
  }
}

/** Points Funnel's public address (port 443) at `port` on this computer, or turns it off (null). Its error says what Tailscale wants, such as Funnel enabled for the tailnet. */
export async function setFunnel(port: number | null): Promise<void> {
  await tailscale(port === null ? ['funnel', '--yes', '--https=443', 'off'] : ['funnel', '--bg', '--yes', String(port)])
}
