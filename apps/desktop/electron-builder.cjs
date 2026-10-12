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
/**
 * macOS, with a Developer ID certificate (MAC_CERTIFICATE, MAC_CERTIFICATE_PASSWORD) and notarized
 * with Apple's (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID). The certificate is handed
 * over here, not as electron-builder's own CSC_LINK: CI sets its variables empty when there's no
 * secret, and an empty CSC_LINK is taken for a path.
 */
const apple = signed && env.MAC_CERTIFICATE && { cscLink: env.MAC_CERTIFICATE, cscKeyPassword: env.MAC_CERTIFICATE_PASSWORD }

/**
 * The Microsoft Store package (MSIX, electron-builder's appx target): the Store signs what's
 * submitted to it, so Windows and the browser never warn about a copy installed from there. Its
 * identity is the one Partner Center gives the app (Product identity: Package/Identity/Name,
 * Package/Identity/Publisher and Package/Properties/PublisherDisplayName), as the repository
 * variables STORE_IDENTITY_NAME, STORE_PUBLISHER and STORE_PUBLISHER_NAME; until they're set, the
 * package is built with stand-ins (it can't be submitted then, but the build is checked). Only
 * Universe (main) is in the Store: build.yml's store job packages it (`--win appx`) on every
 * branch, to check it, and main's release carries it.
 */
const store = {
  identityName: env.STORE_IDENTITY_NAME || 'UniverseMe.Universe',
  publisher: env.STORE_PUBLISHER || 'CN=00000000-0000-0000-0000-000000000000',
  publisherDisplayName: env.STORE_PUBLISHER_NAME || 'universe.me',
  displayName: app.productName,
  applicationId: 'Universe',
  backgroundColor: '#0e1230',
  languages: ['en-US'],
  // Windows 10 1809 and later: as far back as the app runs.
  minVersion: '10.0.17763.0',
  // `universe` on the command line (an app execution alias), for `universe --mcp`.
  customExtensionsPath: 'build/appx-extensions.xml',
  artifactName: 'Universe-${version}-store.${ext}'
}

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
  appx: store,
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
    ...(apple ? { ...apple, hardenedRuntime: true, notarize: !!env.APPLE_TEAM_ID } : { identity: '-' })
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
