/**
 * Self-update, shared by the main process and the renderer. CI publishes an
 * update manifest next to the installers on each channel's rolling release
 * (scripts/update-manifest.mjs), signed (scripts/sign-update.mjs); the app
 * checks the signature, compares versions and picks the installer that
 * matches how it was installed.
 */

/**
 * The branches builds come from, each an app of its own (electron-builder.cjs):
 * its name, and the rolling release it's published to and updates from.
 */
export const CHANNELS = {
  main: { name: 'Universe', release: 'latest-build' },
  staging: { name: 'Universe (staging)', release: 'staging-build' },
  dev: { name: 'Universe (dev)', release: 'dev-build' }
} as const
export type Channel = keyof typeof CHANNELS

/** A channel's signed manifest. (`update.json` beside it, unsigned, is for copies from before signing: each takes one more update that way.) */
export const manifestUrl = (channel: Channel) => `https://github.com/Gabetd/universe.me/releases/download/${CHANNELS[channel].release}/update.signed.json`


/** How this copy of the app was installed, which decides how it replaces itself. */
export type InstallKind = 'win-nsis' | 'win-portable' | 'mac-zip' | 'linux-appimage' | 'linux-deb'

export interface UpdateFile {
  name: string
  /** Base64 SHA-512 of the file. */
  sha512: string
  size: number
}

export interface UpdateManifest {
  version: string
  commit: string
  /** Keyed by `${InstallKind}-${arch}`, e.g. `mac-zip-arm64`. */
  files: Record<string, UpdateFile>
}

export type UpdateStatus =
  | { state: 'none' }
  | { state: 'available'; version: string; needsPassword: boolean }
  | { state: 'downloading'; version: string; progress: number }
  | { state: 'installing'; version: string }
  | { state: 'failed'; version: string; error: string }

/** Compares dotted numeric versions ("0.1.42"): negative if a is older than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/**
 * What an update file may be called: one of the release's own installers. The
 * name becomes a download address next to the manifest, a file in a temp
 * folder and, on Windows, part of a script, so it can't hold a slash, a colon,
 * quotes or anything a shell reads.
 */
const FILE_NAME = /^Universe-\d+\.\d+\.\d+-[A-Za-z0-9_-]+\.(?:exe|zip|AppImage|deb)$/

/** The file this install should update from, if the manifest is newer and has one with a name it can trust. */
export function pickUpdate(manifest: UpdateManifest, current: string, kind: InstallKind, arch: string): UpdateFile | undefined {
  if (compareVersions(manifest.version, current) <= 0) return undefined
  const file = manifest.files[`${kind}-${arch}`]
  return file && FILE_NAME.test(file.name) ? file : undefined
}
