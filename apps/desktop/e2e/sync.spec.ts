import { join } from 'node:path'
import { expect, inspector, newWorld, row, shot, SLOW, stubSaveDialog, test, twoComputers } from './helpers'

/** The two computers on the stand-in tailnet (e2e/fake-tailscale.mjs), both the same owner's. */
const STUDIO = { host: 'studio.tail1234.ts.net', login: 'owner@example.com' }
const LAPTOP = { host: 'laptop.tail1234.ts.net', login: 'owner@example.com' }

test('sync: a universe copied from one computer to another, then kept in step both ways over the tailnet', async () => {
  test.slow()
  await twoComputers(STUDIO, LAPTOP, async (studio, laptop) => {
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
  })
})
