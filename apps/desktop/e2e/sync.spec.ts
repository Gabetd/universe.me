import { readFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, inspector, launch, newWorld, row, shot, SLOW, stubSaveDialog, test, type AppHandle } from './helpers'

/** The two computers on the stand-in tailnet (e2e/fake-tailscale.mjs), both the same owner's. */
const STUDIO = 'studio.tail1234.ts.net'
const LAPTOP = 'laptop.tail1234.ts.net'

/**
 * What `tailscale serve` does for the other computer: forwards to where the
 * app pointed it (read from its stand-in Tailscale's state each time),
 * adding the owner's login and the name it was asked for.
 */
function serve(host: string): { url: Promise<string>; server: Server; app: { dir?: string } } {
  const app: { dir?: string } = {}
  const server = createServer((req, res) => {
    let target: string | undefined
    try {
      target = app.dir && (JSON.parse(readFileSync(join(app.dir, 'tailscale.json'), 'utf8')) as { app?: string }).app
    } catch {
      // Not served yet.
    }
    if (!target) return void res.writeHead(502).end()
    const headers = { ...req.headers, host: `${host}:8443`, 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': 'owner@example.com' }
    const forward = request(new URL(req.url ?? '/', target), { method: req.method, headers }, (answer) => {
      res.writeHead(answer.statusCode!, answer.headers)
      answer.pipe(res)
    })
    forward.on('error', () => res.writeHead(502).end())
    req.pipe(forward)
  })
  const url = new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))
  return { url, server, app }
}

/** A computer on the tailnet: its own Tailscale, which sees the other as its owner's device. */
async function computer(host: string, other: string, otherUrl: string): Promise<AppHandle> {
  return launch(() => ({ FAKE_TAILSCALE_HOST: host, FAKE_TAILSCALE_PEERS: other, UNIVERSE_TAILNET_URLS: JSON.stringify({ [other]: otherUrl }) }))
}

test('sync: a universe copied from one computer to another, then kept in step both ways over the tailnet', async () => {
  test.slow()
  const toStudio = serve(STUDIO)
  const toLaptop = serve(LAPTOP)
  const studio = await computer(STUDIO, LAPTOP, await toLaptop.url)
  const laptop = await computer(LAPTOP, STUDIO, await toStudio.url)
  toStudio.app.dir = studio.dir
  toLaptop.app.dir = laptop.dir
  try {
    // The studio has a universe open, and sync on.
    await newWorld(studio, 'Aerth')
    await studio.page.getByRole('button', { name: 'Connect AI' }).click()
    const studioDevices = studio.page.getByRole('region', { name: 'Your other devices' })
    await studioDevices.getByLabel('Sync with my other devices').check()
    await studio.page.getByRole('button', { name: 'Close connect AI' }).click()

    // The laptop, with nothing open, turns sync on from its start screen and copies the studio's universe.
    const devices = laptop.page.getByRole('region', { name: 'Your other devices' })
    await devices.getByLabel('Sync with my other devices').check()
    await expect(devices.getByRole('list', { name: 'Devices' })).toContainText('studio · has “Aerth” open', { timeout: SLOW })
    await stubSaveDialog(laptop.app, join(laptop.dir, 'Aerth copy.universe'))
    await devices.getByRole('button', { name: 'Copy “Aerth” here' }).click()
    await expect(row(laptop.page, 'Terra Surface')).toBeVisible()

    // A change on either shows on the other.
    await row(studio.page, 'Sol').click()
    const sol = inspector(studio.page).getByLabel('Name', { exact: true })
    await sol.fill('Helios')
    await sol.press('Enter')
    await expect(row(laptop.page, 'Helios')).toBeVisible({ timeout: SLOW })
    await row(laptop.page, 'Terra').click()
    const terra = inspector(laptop.page).getByLabel('Name', { exact: true })
    await terra.fill('Terra Nova')
    await terra.press('Enter')
    await expect(row(studio.page, 'Terra Nova')).toBeVisible({ timeout: SLOW })

    await laptop.page.getByRole('button', { name: 'Connect AI' }).click()
    await expect(laptop.page.getByRole('list', { name: 'Devices' })).toContainText(/studio · in step, synced/)
    await laptop.page.getByRole('region', { name: 'Your other devices' }).scrollIntoViewIfNeeded()
    await shot(laptop.page, '180-sync')
  } finally {
    await Promise.all([studio.app.close(), laptop.app.close()])
    toStudio.server.close()
    toLaptop.server.close()
  }
})
