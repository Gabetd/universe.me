// Packaging (electron-builder). Each branch's builds are an app of their own
// (UNIVERSE_CHANNEL, set by build.yml): main's is "Universe", dev's and
// staging's are "Universe (dev)" and "Universe (staging)", with their own app
// ids, so they install, keep their data and update side by side.
// `exe` (Windows, macOS) and `name` (Linux, the package's too) differ per channel:
// an installer closes running copies of its app by executable name, and one
// channel's must never close another's. (Kept in step with CHANNELS in src/shared/update.ts.)
const CHANNELS = {
  main: { productName: 'Universe', appId: 'me.universe.app', exe: 'Universe', name: 'universe-desktop' },
  staging: { productName: 'Universe (staging)', appId: 'me.universe.app.staging', exe: 'Universe-staging', name: 'universe-desktop-staging' },
  dev: { productName: 'Universe (dev)', appId: 'me.universe.app.dev', exe: 'Universe-dev', name: 'universe-desktop-dev' }
}
const channel = process.env.UNIVERSE_CHANNEL || 'main'
const app = CHANNELS[channel]
if (!app) throw new Error(`UNIVERSE_CHANNEL is ${channel}: it's main, staging or dev`)

// Signing (PLAN.md §9, M19): main's and staging's builds only, and only once CI has the
// certificates as secrets (build.yml passes them to those branches alone); until then,
// and for dev, the builds are as before (Windows unsigned, macOS ad-hoc signed).
const signed = channel === 'main' || channel === 'staging'
const env = process.env
/** Windows, through Azure Artifact Signing (formerly Trusted Signing); its credentials (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET) are read by Microsoft's own signing module. */
const azure = signed && env.AZURE_SIGNING_ENDPOINT && {
  publisherName: env.AZURE_SIGNING_PUBLISHER,
  endpoint: env.AZURE_SIGNING_ENDPOINT,
  codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
  certificateProfileName: env.AZURE_SIGNING_PROFILE
}
/** macOS, with a Developer ID certificate (CSC_LINK, CSC_KEY_PASSWORD) and notarized with Apple's (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID). */
const apple = signed && !!env.CSC_LINK

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: app.appId,
  productName: app.productName,
  // The app's own name (its data folder, its window titles) and the Linux package's follow the channel too.
  extraMetadata: { productName: app.productName, name: app.name },
  executableName: app.exe,
  artifactName: 'Universe-${version}-${os}-${arch}.${ext}',
  directories: { output: 'release', buildResources: 'build' },
  // Main, preload and renderer are fully bundled by electron-vite, so the
  // packaged app only needs the build output.
  files: ['out/**/*', 'package.json'],
  asar: true,
  fileAssociations: [{ ext: 'universe', name: 'Universe Project', role: 'Editor' }],
  win: { target: [{ target: 'portable' }, { target: 'nsis' }], ...(azure && { azureSignOptions: azure }) },
  portable: { artifactName: 'Universe-${version}-windows-portable.${ext}' },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  mac: {
    category: 'public.app-category.productivity',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      // The self-updater installs from the zip.
      { target: 'zip', arch: ['arm64', 'x64'] }
    ],
    // Without a Developer ID certificate, builds are ad-hoc signed ("-"): Apple Silicon refuses to
    // run unsigned apps, and ad-hoc signing is enough to launch after approving in Settings.
    ...(apple ? { hardenedRuntime: true, notarize: !!env.APPLE_TEAM_ID } : { identity: '-' })
  },
  linux: {
    category: 'Graphics',
    target: [{ target: 'AppImage' }, { target: 'deb' }],
    maintainer: 'universe.me',
    syncDesktopName: true,
    // Its own command too, so the channels' .debs can be installed together.
    executableName: app.name
  },
  // Electron's fuses, flipped in the packaged binary: the app's code is only what's in its
  // archive, checked against the hash the binary carries (macOS and Windows), and NODE_OPTIONS
  // can't change how it runs. Running as plain Node stays (`--mcp` serves stdio that way), and
  // so do the inspect switches: the packaged app's end-to-end tests drive it through them.
  electronFuses: {
    runAsNode: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: true,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true
  },
  // CI passes --publish never and uploads artifacts itself, plus the update
  // manifest the in-app updater reads (scripts/update-manifest.mjs).
  publish: { provider: 'github', owner: 'Gabetd', repo: 'universe.me' }
}
