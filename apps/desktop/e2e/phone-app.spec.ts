import type { Server } from 'node:http'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { expect, inspector, newWorld, row, servedTo, shot, tailnetProxy, test } from './helpers'

/** The stand-in Tailscale's name for this computer and its owner (e2e/fake-tailscale.mjs). */
const HOST = 'studio.tail1234.ts.net:8443'
const LOGIN = 'owner@example.com'

/** The stand-in `tailscale serve` for a phone, at localhost (a browser keeps secure cookies there). */
async function serveProxy(target: string, login = LOGIN): Promise<{ url: string; server: Server }> {
  const { port, server } = await tailnetProxy(HOST, () => target, login)
  return { url: `http://localhost:${port}/`, server }
}

async function phone(url: string): Promise<ElectronApplication> {
  return electron.launch({ args: [join(__dirname, 'phone-browser.mjs')], env: { ...process.env, PHONE_URL: url } })
}

test('Universe on your phone: served on the tailnet, signed in with the code the computer shows, the same project both ways, and signed out from the computer', async ({ h }) => {
  test.slow()
  const { page } = h
  await newWorld(h, 'Aerth')

  await page.getByRole('button', { name: 'Connect AI' }).click()
  const panel = page.getByRole('region', { name: 'From your phone' })
  await panel.getByLabel('Use Universe on my phone').check()
  await expect(panel.getByLabel('Open this on your phone')).toHaveValue(`https://${HOST}/`)
  await page.getByRole('button', { name: 'Close connect AI' }).click()
  await expect.poll(() => servedTo(h.dir)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  const target = servedTo(h.dir)!

  // Someone else on the tailnet is turned away; so is the internet (a Funnel request).
  const other = await serveProxy(target, 'someone@example.com')
  expect((await fetch(other.url)).status).toBe(403)
  other.server.close()
  const { url, server } = await serveProxy(target)

  const phoneApp = await phone(url)
  try {
    const screen = await phoneApp.firstWindow()
    // Signing in: the code the computer shows, typed on the phone.
    await expect(screen.getByText('Universe on your phone')).toBeVisible()
    const code = await page.getByLabel('Code for Universe on your phone').textContent()
    await screen.getByLabel('Code').fill(code!)
    await screen.getByRole('button', { name: 'Connect' }).click()

    // The project open on the computer, one panel at a time.
    const tabs = screen.getByRole('navigation', { name: 'Panels' })
    await expect(tabs).toBeVisible()
    await tabs.getByRole('button', { name: /Universe/ }).click()
    await expect(row(screen, 'Terra')).toBeVisible()
    // The world's view is behind the tree here, so it isn't waited for.
    await shot(screen, '170-phone-app', { views: false })

    // A change on the phone shows on the computer…
    await row(screen, 'Terra').click()
    await tabs.getByRole('button', { name: /Details/ }).click()
    const name = inspector(screen).getByLabel('Name', { exact: true })
    await name.fill('Terra Nova')
    await name.press('Enter')
    await expect(row(page, 'Terra Nova')).toBeVisible()
    // …and one on the computer, on the phone.
    await row(page, 'Sol').click()
    const sol = inspector(page).getByLabel('Name', { exact: true })
    await sol.fill('Helios')
    await sol.press('Enter')
    await tabs.getByRole('button', { name: /Universe/ }).click()
    await expect(row(screen, 'Helios')).toBeVisible()
    // What's only for the computer isn't on the phone.
    await expect(screen.getByRole('button', { name: 'Connect AI' })).toHaveCount(0)

    // Removed on the computer: the phone is signed out at its next step.
    await page.getByRole('button', { name: 'Connect AI' }).click()
    const connected = panel.getByRole('list', { name: 'Connected clients' })
    await connected.getByRole('listitem').filter({ hasText: 'Universe on your phone' }).getByRole('button', { name: 'Remove' }).click()
    await row(screen, 'Helios').click()
    await expect(screen.getByLabel('Code')).toBeVisible()
  } finally {
    await phoneApp.close()
    server.close()
  }

  // Off: Serve is turned off.
  await panel.getByLabel('Use Universe on my phone').uncheck()
  await expect.poll(() => servedTo(h.dir)).toBeUndefined()
})
