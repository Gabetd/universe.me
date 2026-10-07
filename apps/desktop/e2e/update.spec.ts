import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, menu } from './helpers'

/** The "new version": an AppImage stand-in that leaves a marker when the updated app is started. */
const NEW_APPIMAGE = '#!/bin/sh\necho started > "$UNIVERSE_E2E_MARKER"\n'

let server: Server
let manifestUrl: string

test.beforeAll(async () => {
  const body = Buffer.from(NEW_APPIMAGE)
  const manifest = {
    version: '99.0.0',
    commit: 'e2e',
    files: { [`linux-appimage-${process.arch}`]: { name: 'Universe-99.0.0.AppImage', sha512: createHash('sha512').update(body).digest('base64'), size: body.length } }
  }
  server = createServer((req, res) => {
    if (req.url === '/update.json') res.end(JSON.stringify(manifest))
    else if (req.url === '/Universe-99.0.0.AppImage') res.end(body)
    else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  manifestUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/update.json`
})
test.afterAll(() => new Promise((resolve) => server.close(resolve)))

test.skip(process.platform !== 'linux', 'Exercises the AppImage installer')

test('offers a newer build, can be dismissed, and upgrades itself with one click', async () => {
  const { app, page, dir } = await launch((dir) => ({
    UNIVERSE_UPDATE_URL: manifestUrl,
    UNIVERSE_UPDATE_KIND: 'linux-appimage',
    APPIMAGE: join(dir, 'Universe.AppImage'),
    UNIVERSE_E2E_MARKER: join(dir, 'started')
  }))
  const appImage = join(dir, 'Universe.AppImage')
  writeFileSync(appImage, 'the old version')

  const banner = page.getByRole('status', { name: 'Update' })
  await expect(banner).toContainText('Universe 99.0.0 is available', { timeout: 15_000 })
  await page.screenshot({ path: 'test-results/update-banner.png' })

  // Dismissed, it stays away until asked for again.
  await banner.getByRole('button', { name: 'Dismiss update' }).click()
  await expect(banner).toBeHidden()
  await menu(app, 'Help', 'Check for Updates…')
  await expect(banner).toBeVisible()

  // One click: download, verify, swap the AppImage, restart into it.
  const closed = app.waitForEvent('close')
  await banner.getByRole('button', { name: 'Upgrade now' }).click()
  await closed
  await expect.poll(() => existsSync(join(dir, 'started')), { timeout: 15_000 }).toBe(true)
  expect(readFileSync(appImage, 'utf8')).toBe(NEW_APPIMAGE)
  expect(statSync(appImage).mode & 0o111).toBeTruthy()
  rmSync(dir, { recursive: true, force: true })
})
