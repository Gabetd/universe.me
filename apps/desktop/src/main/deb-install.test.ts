import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installDeb } from './deb-install'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

/** A folder with a stand-in dpkg (which keeps what it's given to install) and a stand-in pkexec that runs what it's asked as is. */
function standIns() {
  const dir = mkdtempSync(join(tmpdir(), 'universe-deb-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'dpkg'), `#!/bin/sh\ncp "$2" "${dir}/installed.deb"\n`)
  writeFileSync(join(dir, 'pkexec'), `#!/bin/sh\nPATH="${dir}:$PATH" exec "$@"\n`)
  for (const f of ['dpkg', 'pkexec']) chmodSync(join(dir, f), 0o755)
  const deb = join(dir, 'Universe.deb')
  writeFileSync(deb, 'the package')
  return { dir, deb, sha512: createHash('sha512').update('the package').digest('base64') }
}

describe('installing a .deb as root', () => {
  it('installs a copy of its own, checked again, so the download can’t be swapped while the password is asked for', async () => {
    const { dir, deb, sha512 } = standIns()
    await installDeb(deb, { sha512 }, join(dir, 'pkexec'))
    expect(readFileSync(join(dir, 'installed.deb'), 'utf8')).toBe('the package')
  })

  it('installs nothing if the file changed after it was checked', async () => {
    const { dir, deb, sha512 } = standIns()
    writeFileSync(deb, 'something else')
    await expect(installDeb(deb, { sha512 }, join(dir, 'pkexec'))).rejects.toThrow(/changed after it was checked/)
    expect(() => readFileSync(join(dir, 'installed.deb'))).toThrow()
  })
})
