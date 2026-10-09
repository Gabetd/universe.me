import type { Server } from 'node:http'
import { join } from 'node:path'
import { expect, inspector, launch, newWorld, row, servedTo, shot, SLOW, stubSaveDialog, tailnetProxy, test, type AppHandle } from './helpers'

/** The two computers on the stand-in tailnet (e2e/fake-tailscale.mjs), both the same owner's. */
const STUDIO = 'studio.tail1234.ts.net'
const LAPTOP = 'laptop.tail1234.ts.net'

/** The stand-in `tailscale serve` of one of the computers: to wherever its app pointed it. */
function serve(host: string): { url: Promise<string>; server: Promise<Server>; app: { dir?: string } } {
  const app: { dir?: string } = {}
  const proxy = tailnetProxy(`${host}:8443`, () => app.dir && servedTo(app.dir))
  return { url: proxy.then(({ port }) => `http://127.0.0.1:${port}`), server: proxy.then(({ server }) => server), app }
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
    for (const proxy of [toStudio, toLaptop]) (await proxy.server).close()
  }
})
