import { closeSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ours, writePrivate } from './private-file'

/**
 * How an MCP server started by an AI client finds the running app: the app
 * writes where it listens (and its token, so the file is the user's alone)
 * and which project it has open. A project file the MCP server opens itself
 * is locked meanwhile, so the app waits rather than opening it at the same time.
 */
export interface Discovery {
  pid: number
  /** Null while connections are turned off in the app. */
  port: number | null
  token: string
  /** The project open in the app, if any. */
  project: string | null
  /** A project the app is opening (waiting for an MCP server to let go of it). */
  opening?: string
  version: string
}

/**
 * A folder only this user can use: on Linux the session's runtime folder (or
 * one in the home folder), never the shared /tmp, where another user could
 * put a file of their own first; elsewhere the user's own temp folder.
 */
function privateDir(): string {
  if (process.platform !== 'linux') return join(tmpdir(), 'universe-me')
  return process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, 'universe-me') : join(homedir(), '.cache', 'universe-me')
}

export const discoveryPath = () => process.env.UNIVERSE_API_DISCOVERY ?? join(privateDir(), 'api.json')

/** Whether a process is still running. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Writes the discovery, for this user alone. */
export function writeDiscovery(d: Discovery, path = discoveryPath()): void {
  writePrivate(path, JSON.stringify(d))
}

/** The running app's discovery, if it's still running and the file is this user's alone. */
export function readDiscovery(path = discoveryPath()): Discovery | undefined {
  try {
    if (!ours(path)) return undefined
    const d = JSON.parse(readFileSync(path, 'utf8')) as Discovery
    return typeof d.pid === 'number' && alive(d.pid) ? d : undefined
  } catch {
    return undefined
  }
}

/** Removes the discovery file, if it's this process's. */
export function clearDiscovery(path = discoveryPath()): void {
  try {
    if ((JSON.parse(readFileSync(path, 'utf8')) as Discovery).pid === process.pid) rmSync(path)
  } catch {
    // Already gone, or someone else's.
  }
}

/** A path as the file system has it (symlinks and `..` resolved), for comparing. */
export function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const lockPath = (project: string) => `${canonical(project)}.mcp-lock`

/** The process holding a project's lock, if one (still running) does. */
export function lockHolder(project: string): number | undefined {
  try {
    const pid = Number(readFileSync(lockPath(project), 'utf8'))
    return pid > 0 && pid !== process.pid && alive(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

/** A lock whose process has died. A lock just made may not have its process id written yet, so it's only stale once it's a moment old. */
function stale(path: string): boolean {
  try {
    const pid = Number(readFileSync(path, 'utf8'))
    return pid > 0 ? !alive(pid) : Date.now() - statSync(path).mtimeMs > 2000
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Waits (up to `ms`) for whoever holds a project's lock to let go; false if they still hold it. */
export async function waitForUnlock(project: string, ms = 5000): Promise<boolean> {
  for (const end = Date.now() + ms; lockHolder(project) !== undefined; await sleep(50)) if (Date.now() > end) return false
  return true
}

/** Runs `fn` holding a project's lock, waiting for it if another process has it; a lock left by a process that died is taken over. */
export async function withProjectLock<T>(project: string, fn: () => Promise<T>): Promise<T> {
  const path = lockPath(project)
  for (let tries = 0; ; tries++) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      break
    } catch (err) {
      // Only someone else's lock is worth waiting for; a missing folder or no permission isn't.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (stale(path)) rmSync(path, { force: true })
      else if (tries > 200) throw new Error(`${project} is locked by another Universe process`)
      else await sleep(50)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(path, { force: true })
  }
}
