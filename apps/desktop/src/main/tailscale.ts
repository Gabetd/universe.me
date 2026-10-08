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
    // Both at once; Funnel's answer only counts once Tailscale says it's running.
    const [statusJson, funnelJson] = await Promise.all([tailscale(['status', '--json']), tailscale(['funnel', 'status', '--json']).catch(() => '')])
    const status = readStatus(statusJson)
    if (!status.running || !status.host) return { kind: 'stopped', detail: status.backend === 'NeedsLogin' ? 'Tailscale isn’t signed in' : 'Tailscale isn’t running' }
    return { kind: 'ready', host: status.host, funnelPort: funnelPort(funnelJson, status.host) }
  } catch (err) {
    if (err instanceof TailscaleError && err.missing) return { kind: 'missing' }
    return { kind: 'stopped', detail: (err as Error).message }
  }
}

/** Points Funnel's public address (port 443) at `port` on this computer, or turns it off (null). Its error says what Tailscale wants, such as Funnel enabled for the tailnet. */
export async function setFunnel(port: number | null): Promise<void> {
  await tailscale(port === null ? ['funnel', '--yes', '--https=443', 'off'] : ['funnel', '--bg', '--yes', String(port)])
}

/** Turns Funnel off before the app quits: at once, as the process may end before anything async finishes, and only briefly waited for. */
export function funnelOffNow(): void {
  for (const c of commands(['funnel', '--yes', '--https=443', 'off'])) {
    try {
      execFileSync(c.file, c.args, { timeout: 3000, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...c.env } })
      return
    } catch {
      // Not there, or it didn't answer in time: try the next place, or leave it.
    }
  }
}
