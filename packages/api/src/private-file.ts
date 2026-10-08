import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Whether a file is this user's and no one else can read or change it (POSIX; on Windows the user's own folders are theirs). */
export function ours(path: string): boolean {
  if (process.platform === 'win32') return true
  const st = statSync(path)
  return st.uid === process.getuid!() && (st.mode & 0o077) === 0
}

/** Writes a file only this user can read, put in place whole (a reader never sees half of it, and an older file's looser mode isn't kept). */
export function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  rmSync(temp, { force: true })
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, path)
}
