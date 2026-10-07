import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, menu } from './helpers'

/**
 * How each platform's self-install is exercised: the "new version" served,
 * the install kind, and the env that tells the app where its own file is.
 * Linux swaps an AppImage and restarts it (the stand-in leaves a marker);
 * Windows swaps the portable exe from a script once the app has quit.
 */
const PLATFORMS: Partial<Record<NodeJS.Platform, { kind: string; file: string; body: () => Buffer; env: string }>> = {
  linux: { kind: 'linux-appimage', file: 'Universe.AppImage', body: () => Buffer.from('#!/bin/sh\necho started > "$UNIVERSE_E2E_MARKER"\n'), env: 'APPIMAGE' },
  // Any small real program will do as the new exe; it's started after the swap.
  win32: { kind: 'win-portable', file: 'Universe.exe', body: () => readFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe')), env: 'PORTABLE_EXECUTABLE_FILE' }
}
const platform = PLATFORMS[process.platform]

let server: Server
let manifestUrl: string
let body: Buffer

test.skip(!platform, 'Self-install is exercised on Linux and Windows')

test.beforeAll(async () => {
  if (!platform) return
  body = platform.body()
  const manifest = {
    version: '99.0.0',
    commit: 'e2e',
    files: { [`${platform.kind}-${process.arch}`]: { name: 'Universe-99.0.0.bin', sha512: createHash('sha512').update(body).digest('base64'), size: body.length } }
  }
  server = createServer((req, res) => {
    if (req.url === '/update.json') res.end(JSON.stringify(manifest))
    else if (req.url === '/Universe-99.0.0.bin') res.end(body)
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
    UNIVERSE_UPDATE_KIND: kind,
    [env]: join(dir, file),
    UNIVERSE_E2E_MARKER: join(dir, 'started')
  }))
  const installed = join(dir, file)
  writeFileSync(installed, 'the old version')

  const banner = page.getByRole('status', { name: 'Update' })
  await expect(banner).toContainText('Universe 99.0.0 is available', { timeout: 15_000 })
  await page.screenshot({ path: 'test-results/update-banner.png' })

  // Dismissed, it stays away until asked for again.
  await banner.getByRole('button', { name: 'Dismiss update' }).click()
  await expect(banner).toBeHidden()
  await menu(app, 'Help', 'Check for Updates…')
  await expect(banner).toBeVisible()

  // One click: download, verify, swap in the new version, restart into it.
  const closed = app.waitForEvent('close')
  await banner.getByRole('button', { name: 'Upgrade now' }).click()
  await closed
  await expect.poll(() => readFileSync(installed).equals(body), { timeout: 15_000 }).toBe(true)
  if (process.platform === 'linux') {
    await expect.poll(() => existsSync(join(dir, 'started')), { timeout: 15_000 }).toBe(true)
    expect(statSync(installed).mode & 0o111).toBeTruthy()
  }
  // The restarted copy may still hold the file for a moment on Windows.
  await expect.poll(() => (rmSync(dir, { recursive: true, force: true }), true), { timeout: 10_000 }).toBe(true)
})
