import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { UpdateFile } from '../shared/update'

const run = promisify(execFile)

/**
 * Installs a downloaded .deb as root (pkexec asks for the password). Checked
 * as it was downloaded, it could still be swapped by another of the user's
 * programs while the password is asked for, so root copies it first into a
 * folder of its own (which nothing of the user's can write to), checks it
 * there against the manifest's SHA-512 again, and installs that copy.
 */
export async function installDeb(file: string, expected: Pick<UpdateFile, 'sha512'>, pkexec = 'pkexec'): Promise<void> {
  const hex = Buffer.from(expected.sha512, 'base64').toString('hex')
  if (hex.length !== 128) throw new Error('The update’s checksum isn’t a SHA-512.')
  await run(pkexec, ['/bin/sh', '-c', DEB_AS_ROOT, 'universe-update', file, hex])
}

/** What root runs to install a .deb (`installDeb`): `$1` the download, `$2` its SHA-512 in hex. */
export const DEB_AS_ROOT = [
  'set -eu',
  'dir=$(mktemp -d)',
  'trap \'rm -rf "$dir"\' EXIT',
  'cp -- "$1" "$dir/update.deb"',
  'echo "$2  $dir/update.deb" | sha512sum -c --status - || { echo "The update changed after it was checked." >&2; exit 3; }',
  'dpkg -i "$dir/update.deb"'
].join('\n')
