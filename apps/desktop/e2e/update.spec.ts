import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, menu, shot, SLOW } from './helpers'

/**
 * How each platform's self-install is exercised: the "new version" served,
 * the install kind, and the env that tells the app where its own file is.
 * Linux swaps an AppImage and restarts it (the stand-in leaves a marker);
 * Windows swaps the portable exe from a script once the app has quit.
 */
const PLATFORMS: Partial<Record<NodeJS.Platform, { kind: string; file: string; served: string; body: () => Buffer; env: string }>> = {
  linux: { kind: 'linux-appimage', file: 'Universe.AppImage', served: 'Universe-99.0.0-linux-x86_64.AppImage', body: () => Buffer.from('#!/bin/sh\necho started > "$UNIVERSE_E2E_MARKER"\n'), env: 'APPIMAGE' },
  // Any small real program will do as the new exe; it's started after the swap.
  win32: { kind: 'win-portable', file: 'Universe.exe', served: 'Universe-99.0.0-windows-portable.exe', body: () => readFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe')), env: 'PORTABLE_EXECUTABLE_FILE' }
}
const platform = PLATFORMS[process.platform]

let server: Server
let manifestUrl: string
let body: Buffer

/** The test's own signing key, as CI's is (scripts/sign-update.mjs), and another one. */
const signer = generateKeyPairSync('ed25519')
const forger = generateKeyPairSync('ed25519')
const PUBLIC_KEY = signer.publicKey.export({ format: 'jwk' }).x!
const signed = (manifest: object, key: KeyObject = signer.privateKey) => {
  const text = JSON.stringify(manifest)
  return JSON.stringify({ manifest: text, signature: sign(null, Buffer.from(text), key).toString('base64') })
}

test.skip(!platform, 'Self-install is exercised on Linux and Windows')

test.beforeAll(async () => {
  if (!platform) return
  body = platform.body()
  const manifest = {
    version: '99.0.0',
    commit: 'e2e',
    files: { [`${platform.kind}-${process.arch}`]: { name: platform.served, sha512: createHash('sha512').update(body).digest('base64'), size: body.length } }
  }
  server = createServer((req, res) => {
    if (req.url === '/update.json') res.end(signed(manifest))
    else if (req.url === '/old.json') res.end(signed({ ...manifest, version: '0.0.1' }))
    else if (req.url === '/forged.json') res.end(signed(manifest, forger.privateKey))
    else if (req.url === `/${platform.served}`) res.end(body)
    else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  manifestUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/update.json`
})
test.afterAll(() => new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined))))

test('offers a newer build, can be dismissed, and upgrades itself with one click', async () => {
  const { kind, file, env } = platform!
  const { app, page, dir } = await launch((dir) => ({
    UNIVERSE_UPDATE_URL: manifestUrl,
    UNIVERSE_UPDATE_PUBLIC_KEY: PUBLIC_KEY,
    UNIVERSE_UPDATE_KIND: kind,
    [env]: join(dir, file),
    UNIVERSE_E2E_MARKER: join(dir, 'started')
  }))
  const installed = join(dir, file)
  writeFileSync(installed, 'the old version')

  const banner = page.getByRole('status', { name: 'Update', exact: true })
  await expect(banner).toContainText('Universe 99.0.0 is available', { timeout: SLOW })
  await shot(page, 'update-banner')

  // Dismissed, it stays away until asked for again: from the Help menu, or the button on the start screen (and in a project's status bar).
  await banner.getByRole('button', { name: 'Dismiss update' }).click()
  await expect(banner).toBeHidden()
  await menu(app, 'Help', 'Check for Updates…')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Dismiss update' }).click()
  await page.getByRole('button', { name: 'Check for updates' }).click()
  await expect(banner).toBeVisible()
  await expect(page.getByRole('status', { name: 'Update check' })).toHaveCount(0)

  // One click: download, verify, swap in the new version, restart into it.
  const closed = app.waitForEvent('close')
  await banner.getByRole('button', { name: 'Upgrade now' }).click()
  await closed
  await expect.poll(() => readFileSync(installed).equals(body), { timeout: SLOW }).toBe(true)
  if (process.platform === 'linux') {
    await expect.poll(() => existsSync(join(dir, 'started')), { timeout: SLOW }).toBe(true)
    expect(statSync(installed).mode & 0o111).toBeTruthy()
  }
  // The restarted copy may still hold the file for a moment on Windows.
  await expect.poll(() => (rmSync(dir, { recursive: true, force: true }), true), { timeout: 10_000 }).toBe(true)
})

test('Check for updates says when there is nothing to install, and why', async () => {
  /** A copy started with `env` (and the test's key), asked to check. */
  const check = async (env: Record<string, string>) => {
    const launched = await launch(() => ({ UNIVERSE_UPDATE_PUBLIC_KEY: PUBLIC_KEY, ...env }))
    await launched.page.getByRole('button', { name: 'Check for updates' }).click()
    return launched
  }
  // Already the latest build.
  let { app, page } = await check({ UNIVERSE_UPDATE_URL: manifestUrl.replace('update.json', 'old.json'), UNIVERSE_UPDATE_KIND: platform!.kind })
  await expect(page.getByRole('status', { name: 'Update check' })).toHaveText(/^Universe [\d.]+ is the latest version\.$/)
  await shot(page, '141-check-for-updates')
  await expect(page.getByRole('status', { name: 'Update', exact: true })).toHaveCount(0)
  await app.close()

  // A newer one, for a copy that can't replace itself (this test build isn't installed, or, packaged on Windows, is a kind the build has no file for).
  ;({ app, page } = await check({ UNIVERSE_UPDATE_URL: manifestUrl }))
  await expect(page.getByRole('status', { name: 'Update check' })).toContainText('Universe 99.0.0 is out. This copy can’t install it itself')
  await app.close()

  // One not signed with the app's key (someone else's release, or a changed one) isn't offered, nor is anything to a copy that can't check.
  ;({ app, page } = await check({ UNIVERSE_UPDATE_URL: manifestUrl.replace('update.json', 'forged.json'), UNIVERSE_UPDATE_KIND: platform!.kind }))
  await expect(page.getByRole('status', { name: 'Update check' })).toHaveText('The latest build isn’t signed with Universe’s key, so this copy won’t install it.')
  await expect(page.getByRole('status', { name: 'Update', exact: true })).toHaveCount(0)
  await app.close()
  ;({ app, page } = await check({ UNIVERSE_UPDATE_URL: manifestUrl, UNIVERSE_UPDATE_PUBLIC_KEY: '', UNIVERSE_UPDATE_KIND: platform!.kind }))
  await expect(page.getByRole('status', { name: 'Update check' })).toContainText('This copy can’t check that an update is genuine')
  await expect(page.getByRole('status', { name: 'Update', exact: true })).toHaveCount(0)
  await app.close()
})
