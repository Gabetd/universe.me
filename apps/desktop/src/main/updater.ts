import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { constants, createWriteStream } from 'node:fs'
import { access, chmod, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { app, net } from 'electron'
import { UPDATE_MANIFEST_URL, compareVersions, pickUpdate, type InstallKind, type UpdateFile, type UpdateStatus } from '../shared/update'
import { UPDATE_PUBLIC_KEY } from './update-key'
import { UntrustedUpdate, readSignedManifest } from './update-signature'

const run = promisify(execFile)
const CHECK_EVERY_MS = 60 * 60 * 1000
const FIRST_CHECK_MS = 5000

/**
 * Checks the latest-build release for a newer version and, on request,
 * downloads it, verifies it and replaces this copy of the app without asking
 * anything (except the system password for a .deb, which needs root). Only a
 * manifest signed with the key in update-key.ts is believed (see
 * update-signature.ts); a copy without that key installs nothing.
 *
 * UNIVERSE_UPDATE_URL points at another manifest ("off" disables checks);
 * UNIVERSE_UPDATE_KIND forces an install kind; UNIVERSE_UPDATE_PUBLIC_KEY is
 * another key to check it with. All three are for tests.
 */
export class Updater {
  private status: UpdateStatus = { state: 'none' }
  private file: UpdateFile | undefined
  private dismissed: string | undefined
  private readonly manifestUrl = process.env.UNIVERSE_UPDATE_URL ?? UPDATE_MANIFEST_URL
  private readonly kind = installKind()
  private readonly publicKey = process.env.UNIVERSE_UPDATE_PUBLIC_KEY ?? UPDATE_PUBLIC_KEY

  constructor(private readonly onStatus: (status: UpdateStatus) => void) {}

  start(): void {
    if (!this.kind || this.manifestUrl === 'off' || !this.publicKey) return
    setTimeout(() => void this.check(), FIRST_CHECK_MS).unref()
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref()
  }

  current(): UpdateStatus {
    return this.status
  }

  /** Hides the banner for this version; a newer one shows it again. */
  dismiss(): void {
    if (this.status.state !== 'available' && this.status.state !== 'failed') return
    this.dismissed = this.status.version
    this.set({ state: 'none' })
  }

  /**
   * Looks for a newer version and offers it. Resolves to why nothing was offered,
   * or null if the banner is showing. `manual` re-offers a dismissed version.
   */
  async check(manual = false): Promise<string | null> {
    if (this.manifestUrl === 'off') return 'Checking for updates is turned off.'
    if (!this.publicKey) return 'This copy can’t check that an update is genuine, so it doesn’t look for them: download the latest from the project’s releases on GitHub.'
    if (this.status.state === 'downloading' || this.status.state === 'installing') return null
    if (manual) this.dismissed = undefined
    try {
      const res = await net.fetch(this.manifestUrl, { cache: 'no-store' })
      // Missing while CI swaps the release's files; try again next time.
      if (!res.ok) return 'The latest build is being published right now. Try again in a few minutes.'
      const manifest = readSignedManifest(await res.text(), this.publicKey)
      const latest = `Universe ${app.getVersion()} is the latest version.`
      if (compareVersions(manifest.version, app.getVersion()) <= 0) return latest
      // A copy that can't replace itself (a development build, one unpacked by hand, or a kind of install the build has no file for) can still say what's new.
      const file = this.kind && pickUpdate(manifest, app.getVersion(), this.kind, process.arch)
      if (!file) return `Universe ${manifest.version} is out. This copy can’t install it itself: download it from the project’s releases on GitHub.`
      if (manifest.version === this.dismissed) return null
      this.file = file
      this.set({ state: 'available', version: manifest.version, needsPassword: this.kind === 'linux-deb' })
      return null
    } catch (err) {
      return err instanceof UntrustedUpdate ? err.message : "Couldn't reach GitHub to check for updates."
    }
  }

  /** Downloads, verifies and installs the offered update, then restarts into it. */
  async install(): Promise<void> {
    const { status, file, kind } = this
    if ((status.state !== 'available' && status.state !== 'failed') || !file || !kind) return
    const version = status.version
    try {
      this.set({ state: 'downloading', version, progress: 0 })
      const dir = await mkdtemp(join(tmpdir(), 'universe-update-'))
      const downloaded = join(dir, file.name)
      await download(new URL(file.name, this.manifestUrl).href, downloaded, file, (progress) => this.set({ state: 'downloading', version, progress }))
      this.set({ state: 'installing', version })
      await INSTALLERS[kind](downloaded, dir)
    } catch (err) {
      this.set({ state: 'failed', version, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private set(status: UpdateStatus): void {
    this.status = status
    this.onStatus(status)
  }
}

function installKind(): InstallKind | null {
  const forced = process.env.UNIVERSE_UPDATE_KIND as InstallKind | undefined
  if (forced) return forced
  if (!app.isPackaged) return null
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_FILE ? 'win-portable' : 'win-nsis'
  if (process.platform === 'darwin') return 'mac-zip'
  if (process.platform === 'linux') {
    if (process.env.APPIMAGE) return 'linux-appimage'
    if (process.execPath.startsWith('/opt/')) return 'linux-deb'
  }
  return null
}

/** Streams `url` to `dest`, reporting progress (0–1) and checking size and SHA-512. */
async function download(url: string, dest: string, expected: UpdateFile, onProgress: (p: number) => void): Promise<void> {
  const res = await net.fetch(url, { cache: 'no-store' })
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`)
  const hash = createHash('sha512')
  const out = createWriteStream(dest)
  let received = 0
  let reported = -1
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length
      // More than the manifest says: not the file it means. Stop rather than fill the disk.
      if (received > expected.size) throw new Error('The download was bigger than expected. Try again.')
      hash.update(chunk)
      const percent = Math.floor((received / expected.size) * 100)
      if (percent !== reported) onProgress(Math.min(1, (reported = percent) / 100))
      if (!out.write(chunk)) await once(out, 'drain')
    }
  } finally {
    out.end()
    await once(out, 'close')
  }
  if (received !== expected.size || hash.digest('base64') !== expected.sha512) throw new Error('The download was incomplete or corrupted. Try again.')
}

/** Runs a shell script after this process exits, detached so it outlives it. */
function afterExit(script: string, ...args: string[]): void {
  spawn('/bin/sh', ['-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done; ${script}`, 'sh', ...args], { detached: true, stdio: 'ignore' }).unref()
  app.quit()
}

const INSTALLERS: Record<InstallKind, (file: string, dir: string) => Promise<void>> = {
  // The NSIS installer closes the app itself, installs where it was installed before, then starts it.
  'win-nsis': async (file) => {
    spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
    app.quit()
  },

  // A portable exe can't be overwritten while it runs, so swap it from a script once the app exits.
  'win-portable': async (file, dir) => {
    const target = process.env.PORTABLE_EXECUTABLE_FILE!
    const script = join(dir, 'swap.cmd')
    await writeFile(
      script,
      [
        '@echo off',
        'set tries=0',
        ':retry',
        `move /y "${file}" "${target}" >nul 2>&1 && goto done`,
        'set /a tries+=1',
        'if %tries% geq 120 goto done',
        'ping -n 2 127.0.0.1 >nul',
        'goto retry',
        ':done',
        `start "" "${target}"`
      ].join('\r\n')
    )
    spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    app.quit()
  },

  // Replace the whole .app bundle once the app exits, then open the new one.
  'mac-zip': async (file, dir) => {
    const bundle = resolve(process.execPath, '../../..')
    if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) throw new Error('Move Universe to your Applications folder, then update.')
    await access(dirname(bundle), constants.W_OK).catch(() => {
      throw new Error(`Universe can't write to ${dirname(bundle)}.`)
    })
    const unpacked = join(dir, 'unpacked')
    await run('/usr/bin/ditto', ['-x', '-k', file, unpacked])
    const name = (await readdir(unpacked)).find((n) => n.endsWith('.app'))
    if (!name) throw new Error('The update has no app in it.')
    afterExit('rm -rf "$1.old" && mv "$1" "$1.old" && mv "$2" "$1" && rm -rf "$1.old"; xattr -dr com.apple.quarantine "$1" 2>/dev/null; open "$1"', bundle, join(unpacked, name))
  },

  // A running AppImage can be renamed over (the old file stays open), so swap it now and relaunch.
  'linux-appimage': async (file) => {
    const target = process.env.APPIMAGE!
    const staged = `${target}.update`
    await rm(staged, { force: true })
    // Next to the target so the final rename is atomic on the same filesystem.
    await run('cp', [file, staged])
    await chmod(staged, 0o755)
    await rename(staged, target)
    app.relaunch({ execPath: target, args: process.argv.slice(1) })
    app.quit()
  },

  // System packages need root: pkexec asks for the password, then the app restarts.
  'linux-deb': async (file) => {
    await run('pkexec', ['dpkg', '-i', file])
    app.relaunch()
    app.quit()
  }
}
