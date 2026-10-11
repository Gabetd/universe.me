import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { constants, createWriteStream } from 'node:fs'
import { access, chmod, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { app, net } from 'electron'
import { CHANNELS, CHANNEL_ORDER, manifestUrl, compareVersions, pickUpdate, type Channel, type ChannelVersion, type InstallKind, type UpdateFile, type UpdateManifest, type UpdateStatus } from '../shared/update'
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
 * Change version lists every channel's newest build (shared/update.ts
 * `CHANNELS`) and installs another channel's app beside this one.
 *
 * UNIVERSE_UPDATE_URL points at another manifest for this copy's channel
 * ("off" disables checks), UNIVERSE_UPDATE_URLS (JSON, by channel) at others';
 * UNIVERSE_UPDATE_KIND forces an install kind; UNIVERSE_UPDATE_PUBLIC_KEY is
 * another key to check them with. All are for tests.
 */
export class Updater {
  private status: UpdateStatus = { state: 'none' }
  private file: UpdateFile | undefined
  private dismissed: string | undefined
  private readonly manifestUrl: string
  private readonly kind = installKind()
  private readonly publicKey = process.env.UNIVERSE_UPDATE_PUBLIC_KEY ?? UPDATE_PUBLIC_KEY

  private readonly urls: Partial<Record<Channel, string>> = process.env.UNIVERSE_UPDATE_URLS ? JSON.parse(process.env.UNIVERSE_UPDATE_URLS) : {}

  /** Updates come from `channel`'s release: a dev copy only ever becomes a newer dev build. */
  constructor(
    private readonly channel: Channel,
    private readonly onStatus: (status: UpdateStatus) => void
  ) {
    this.manifestUrl = process.env.UNIVERSE_UPDATE_URL ?? this.urls[channel] ?? manifestUrl(channel)
  }

  private urlOf(channel: Channel): string {
    return channel === this.channel ? this.manifestUrl : (this.urls[channel] ?? manifestUrl(channel))
  }

  /** A channel's manifest, if it's there and signed with Universe's key. */
  private async manifest(channel: Channel): Promise<UpdateManifest> {
    const res = await net.fetch(this.urlOf(channel), { cache: 'no-store' })
    // Missing while CI swaps the release's files; try again next time.
    if (!res.ok) throw new NotPublishedYet()
    return readSignedManifest(await res.text(), this.publicKey)
  }

  /** Every channel's newest build, for Change version, all asked at once. */
  async versions(): Promise<ChannelVersion[]> {
    const off = this.manifestUrl === 'off' || !this.publicKey
    return Promise.all(
      CHANNEL_ORDER.map(async (channel): Promise<ChannelVersion> => {
        const base = { channel, current: channel === this.channel }
        if (off) return { ...base, installable: false, error: 'This copy doesn’t check for versions.' }
        try {
          const manifest = await this.manifest(channel)
          return { ...base, version: manifest.version, installable: !!this.kind && !!pickUpdate(manifest, '0', this.kind, process.arch) }
        } catch (err) {
          return { ...base, installable: false, error: err instanceof UntrustedUpdate || err instanceof NotPublishedYet ? err.message : 'Couldn’t reach GitHub.' }
        }
      })
    )
  }

  /**
   * Downloads, verifies and installs another channel's app (Universe (dev),
   * say) beside this one, and opens it; this copy stays as it is. Resolves to
   * why it couldn't, or null once it's opening.
   */
  async installBeside(channel: Channel): Promise<string | null> {
    const { kind } = this
    if (!CHANNEL_ORDER.includes(channel)) return 'There’s no such version.'
    if (channel === this.channel) return 'That’s this copy: use Update instead.'
    if (!kind || !this.publicKey) return `This copy can’t install other versions itself: download ${CHANNELS[channel].name} from the project’s releases on GitHub.`
    try {
      const manifest = await this.manifest(channel)
      const file = pickUpdate(manifest, '0', kind, process.arch)
      if (!file) return `${CHANNELS[channel].name} has no build for this computer yet.`
      const { dir, downloaded } = await downloadToTemp(this.urlOf(channel), file, () => {})
      await BESIDE[kind](downloaded, dir, channel)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

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
      const manifest = await this.manifest(this.channel)
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
      return err instanceof UntrustedUpdate || err instanceof NotPublishedYet ? err.message : "Couldn't reach GitHub to check for updates."
    }
  }

  /** Downloads, verifies and installs the offered update, then restarts into it. */
  async install(): Promise<void> {
    const { status, file, kind } = this
    if ((status.state !== 'available' && status.state !== 'failed') || !file || !kind) return
    const version = status.version
    try {
      this.set({ state: 'downloading', version, progress: 0 })
      const { dir, downloaded } = await downloadToTemp(this.manifestUrl, file, (progress) => this.set({ state: 'downloading', version, progress }))
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

/** The release's file is missing: CI is swapping the release's files. */
class NotPublishedYet extends Error {
  constructor() {
    super('The build is being published right now. Try again in a few minutes.')
  }
}

/** Starts a program on its own, not as this app's child, so it outlives it. */
const startApart = (file: string, args: string[] = []) => spawn(file, args, { detached: true, stdio: 'ignore' }).unref()

/** This copy's .app bundle, refusing one macOS runs from a read-only place (a disk image, or translocated from Downloads). */
function appBundle(): string {
  const bundle = resolve(process.execPath, '../../..')
  if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) throw new Error('Move Universe to your Applications folder first.')
  return bundle
}

/** Unzips a macOS download into `dir`, and finds the .app in it. */
async function unzipApp(file: string, dir: string): Promise<string> {
  const unpacked = join(dir, 'unpacked')
  await run('/usr/bin/ditto', ['-x', '-k', file, unpacked])
  const name = (await readdir(unpacked)).find((n) => n.endsWith('.app'))
  if (!name) throw new Error('The download has no app in it.')
  return join(unpacked, name)
}

/** Copies an executable to `target` through a file beside it, so the last step is an atomic rename on the same filesystem. */
async function placeExecutable(file: string, target: string): Promise<void> {
  const staged = `${target}.download`
  await rm(staged, { force: true })
  await run('cp', [file, staged])
  await chmod(staged, 0o755)
  await rename(staged, target)
}

/**
 * Installs another channel's app beside this one, and opens it: the same
 * kind of install as this copy (an installer, a portable exe or an AppImage
 * next to this one's, a .app next to this one's bundle, a .deb), as its own
 * app, which updates from its own release from then on.
 */
const BESIDE: Record<InstallKind, (file: string, dir: string, channel: Channel) => Promise<void>> = {
  // Its own app id and install folder: the installer leaves this one alone, and starts the new one when it's done.
  'win-nsis': async (file) => void startApart(file, ['/S', '--force-run']),

  'win-portable': async (file, _dir, channel) => {
    const target = join(dirname(process.env.PORTABLE_EXECUTABLE_FILE!), `${CHANNELS[channel].name}.exe`)
    await rm(target, { force: true })
    await rename(file, target).catch(() => run('cmd.exe', ['/c', 'copy', '/y', file, target]))
    startApart(target)
  },

  'mac-zip': async (file, dir, channel) => {
    const unpacked = await unzipApp(file, dir)
    // Next to this one (Applications, usually), replacing an older copy of that channel.
    const target = join(dirname(appBundle()), `${CHANNELS[channel].name}.app`)
    await rm(target, { recursive: true, force: true })
    await run('/bin/mv', [unpacked, target])
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', target]).catch(() => {})
    startApart('/usr/bin/open', [target])
  },

  'linux-appimage': async (file, _dir, channel) => {
    const target = join(dirname(process.env.APPIMAGE!), `Universe-${channel}.AppImage`)
    await placeExecutable(file, target)
    startApart(target)
  },

  'linux-deb': async (file, _dir, channel) => {
    await run('pkexec', ['dpkg', '-i', file])
    startApart(CHANNELS[channel].command)
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

/** Downloads a manifest's file (named relative to the manifest's URL) into a new temporary folder. */
async function downloadToTemp(manifestUrl: string, file: UpdateFile, onProgress: (p: number) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'universe-update-'))
  const downloaded = join(dir, file.name)
  await download(new URL(file.name, manifestUrl).href, downloaded, file, onProgress)
  return { dir, downloaded }
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
    startApart(file, ['/S', '--updated', '--force-run'])
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
    const bundle = appBundle()
    await access(dirname(bundle), constants.W_OK).catch(() => {
      throw new Error(`Universe can't write to ${dirname(bundle)}.`)
    })
    afterExit('rm -rf "$1.old" && mv "$1" "$1.old" && mv "$2" "$1" && rm -rf "$1.old"; xattr -dr com.apple.quarantine "$1" 2>/dev/null; open "$1"', bundle, await unzipApp(file, dir))
  },

  // A running AppImage can be renamed over (the old file stays open), so swap it now and relaunch.
  'linux-appimage': async (file) => {
    const target = process.env.APPIMAGE!
    await placeExecutable(file, target)
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
