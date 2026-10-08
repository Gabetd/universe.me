import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Whether a file is this user's and no one else can read or change it (POSIX; on Windows the user's own folders are theirs). */
export function ours(path: string): boolean {
  if (process.platform === 'win32') return true
  const st = statSync(path)
  return st.uid === process.getuid!() && (st.mode & 0o077) === 0
}

/**
 * Writes a file only this user can read, put in place whole (a reader never
 * sees half of it, and an older file's looser mode isn't kept). Its folder has
 * to be this user's alone, not a link: one someone else made first in a
 * shared place (/tmp) could otherwise catch what's written.
 */
export function writePrivate(path: string, text: string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o022) !== 0) throw new Error(`${dir} isn’t this user’s own folder`)
  }
  // A new file of a name no one can guess, never one that's there already (or a link planted in its place).
  const temp = join(dir, `.${randomBytes(8).toString('hex')}.tmp`)
  writeFileSync(temp, text, { mode: 0o600, flag: 'wx' })
  renameSync(temp, path)
}
