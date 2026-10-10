// Packaging (electron-builder). Each branch's builds are an app of their own
// (UNIVERSE_CHANNEL, set by build.yml): main's is "Universe", dev's and
// staging's are "Universe (dev)" and "Universe (staging)", with their own app
// ids, so they install, keep their data and update side by side.
const CHANNELS = {
  main: { productName: 'Universe', appId: 'me.universe.app', name: 'universe-desktop' },
  staging: { productName: 'Universe (staging)', appId: 'me.universe.app.staging', name: 'universe-desktop-staging' },
  dev: { productName: 'Universe (dev)', appId: 'me.universe.app.dev', name: 'universe-desktop-dev' }
}
const channel = process.env.UNIVERSE_CHANNEL || 'main'
const app = CHANNELS[channel]
if (!app) throw new Error(`UNIVERSE_CHANNEL is ${channel}: it's main, staging or dev`)

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: app.appId,
  productName: app.productName,
  // The app's own name (its data folder, its window titles) and the Linux package's follow the channel too.
  extraMetadata: { productName: app.productName, name: app.name },
  // Universe.exe in every channel on Windows, so the tests and the command line find it.
  executableName: 'Universe',
  artifactName: 'Universe-${version}-${os}-${arch}.${ext}',
  directories: { output: 'release', buildResources: 'build' },
  // Main, preload and renderer are fully bundled by electron-vite, so the
  // packaged app only needs the build output.
  files: ['out/**/*', 'package.json'],
  asar: true,
  fileAssociations: [{ ext: 'universe', name: 'Universe Project', role: 'Editor' }],
  win: { target: [{ target: 'portable' }, { target: 'nsis' }] },
  portable: { artifactName: 'Universe-${version}-windows-portable.${ext}' },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  mac: {
    category: 'public.app-category.productivity',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      // The self-updater installs from the zip.
      { target: 'zip', arch: ['arm64', 'x64'] }
    ],
    // No Apple Developer certificate yet, so builds are ad-hoc signed ("-").
    // Apple Silicon refuses to run unsigned apps; ad-hoc signing is enough to launch after approving in Settings.
    identity: '-'
  },
  linux: {
    category: 'Graphics',
    target: [{ target: 'AppImage' }, { target: 'deb' }],
    maintainer: 'universe.me',
    syncDesktopName: true,
    // Its own command too, so the channels' .debs can be installed together.
    executableName: app.name
  },
  // CI passes --publish never and uploads artifacts itself, plus the update
  // manifest the in-app updater reads (scripts/update-manifest.mjs).
  publish: { provider: 'github', owner: 'Gabetd', repo: 'universe.me' }
}
