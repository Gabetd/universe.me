import type { Server } from 'node:http'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, fill, inspector, launch, newWorld, row, servedTo, shot, SLOW, state, stubSaveDialog, tailnetProxy, test, type AppHandle } from './helpers'

/** Two people on the stand-in tailnet (e2e/fake-tailscale.mjs), each on a computer of their own: Ana's studio makes the universe, and she shares it with Bea. */
const ANA = { login: 'ana@example.com', host: 'studio.tail1234.ts.net' }
const BEA = { login: 'bea@example.com', host: 'bea-laptop.tail1234.ts.net' }
type Someone = typeof ANA

/** The stand-in `tailscale serve` of `someone`'s computer: to wherever its app pointed it, saying the one asking is `visitor`. */
function serve(someone: Someone, visitor: Someone): { url: Promise<string>; server: Promise<Server>; app: { dir?: string } } {
  const app: { dir?: string } = {}
  const proxy = tailnetProxy(`${someone.host}:8443`, () => app.dir && servedTo(app.dir), visitor.login)
  return { url: proxy.then(({ port }) => `http://127.0.0.1:${port}`), server: proxy.then(({ server }) => server), app }
}

/** Someone's computer: signed in to Tailscale as them, seeing the other person's computer on the tailnet. */
function computer(someone: Someone, other: Someone, otherUrl: string): Promise<AppHandle> {
  return launch(() => ({
    FAKE_TAILSCALE_HOST: someone.host,
    FAKE_TAILSCALE_LOGIN: someone.login,
    FAKE_TAILSCALE_OTHERS: `${other.host}=${other.login}`,
    UNIVERSE_TAILNET_URLS: JSON.stringify({ [other.host]: otherUrl })
  }))
}

const shareDialog = (page: Page) => page.getByRole('dialog', { name: 'Share this universe' })
const openShare = (page: Page) => page.getByRole('button', { name: '👥 Share', exact: true }).click()
const whosIn = (page: Page) => page.getByRole('group', { name: 'Who’s in' })
const eventBar = (page: Page, title: string) => page.locator('.tl-event', { hasText: title })
const firstEvent = async (page: Page) => (await state(page, 'timeline')).events[0]

test('collaboration: a universe shared with someone else, both in it at once, editing one event, then not shared with them any more', async () => {
  test.slow()
  const toAna = serve(ANA, BEA)
  const toBea = serve(BEA, ANA)
  const ana = await computer(ANA, BEA, await toBea.url)
  const bea = await computer(BEA, ANA, await toAna.url)
  toAna.app.dir = ana.dir
  toBea.app.dir = bea.dir
  try {
    // Ana makes a universe and opens Share: sync is off, so it offers to turn it on.
    await newWorld(ana, 'Aerth', { surface: false })
    await openShare(ana.page)
    const share = shareDialog(ana.page)
    await expect(share.getByLabel('Sharing status')).toHaveText(/sync, which is off/)
    await share.getByRole('button', { name: 'Turn on sync' }).click()

    // Bea is on the tailnet, so she's offered: one click invites her, and lists Ana too.
    await share.getByRole('group', { name: 'On your tailnet' }).getByRole('button', { name: '+ bea' }).click()
    const members = share.getByRole('list', { name: 'Members' })
    await expect(members.getByRole('listitem')).toHaveCount(2)
    await expect(members).toContainText('bea · bea@example.com')
    await expect(members).toContainText('ana · ana@example.com')

    // Bea, with nothing open, turns sync on from her start screen: Ana's universe is shared with her there, to copy.
    const devices = bea.page.getByRole('region', { name: 'Your other devices' })
    await devices.getByLabel('Sync with my other devices').check()
    const sharedWithBea = devices.getByRole('list', { name: 'Shared with you' })
    await expect(sharedWithBea).toContainText('ana’s studio · has “Aerth” open', { timeout: SLOW })
    await stubSaveDialog(bea.app, join(bea.dir, 'Aerth.universe'))
    await sharedWithBea.getByRole('button', { name: 'Copy “Aerth” here' }).click()
    await expect(row(bea.page, 'Terra')).toBeVisible()

    // Each sees the other in, and where: in the top bar, on the tree and in the list of people.
    await row(bea.page, 'Sol').click()
    await expect(whosIn(ana.page).getByRole('button', { name: 'bea, on Sol' })).toBeVisible({ timeout: SLOW })
    await expect(row(ana.page, 'Sol').getByLabel('bea, on Sol')).toBeVisible()
    await expect(whosIn(bea.page).getByRole('button', { name: 'ana, on Terra' })).toBeVisible({ timeout: SLOW })
    await expect(members.getByRole('listitem').filter({ hasText: 'bea@example.com' })).toContainText('in now, on Sol')
    await shot(ana.page, '240-share')
    await ana.page.getByRole('button', { name: 'Close share' }).click()
    await shot(ana.page, '241-people-in')

    // A click on Bea's mark goes where she is.
    await whosIn(ana.page).getByRole('button', { name: 'bea, on Sol' }).click()
    await expect(ana.page.locator('.tree-row.selected')).toHaveText(/Sol/)

    // An event Ana makes reaches Bea; then each changes a different field of it at once, and both changes end up on both.
    await row(ana.page, 'Terra').click()
    await ana.page.getByRole('button', { name: '+ Event' }).click()
    await fill(ana.page, 'Event title', 'Founding')
    await row(bea.page, 'Terra').click()
    await expect(eventBar(bea.page, 'Founding')).toBeVisible({ timeout: SLOW })
    await eventBar(bea.page, 'Founding').click()
    await expect(inspector(bea.page).getByRole('region', { name: 'Event' })).toBeVisible()
    const before = (await firstEvent(ana.page))!.start
    await Promise.all([fill(ana.page, 'Event title', 'Founding of Aster'), fill(bea.page, 'Starts', '1204')])
    await expect
      .poll(
        async () => {
          const [a, b] = await Promise.all([firstEvent(ana.page), firstEvent(bea.page)])
          return a?.title === 'Founding of Aster' && b?.title === a.title && a.start !== before && b.start === a.start
        },
        { timeout: SLOW }
      )
      .toBe(true)

    // Ana removes Bea (from the right-click menu): Ana's studio stops answering her, so the universe is no longer shared with her, and her changes stay hers.
    await openShare(ana.page)
    await members.getByRole('listitem').filter({ hasText: 'bea@example.com' }).click({ button: 'right' })
    await ana.page.getByRole('menuitem', { name: 'Remove bea' }).click()
    await expect(members.getByRole('listitem')).toHaveCount(1)
    await bea.page.getByRole('button', { name: 'Connect AI' }).click()
    await expect(bea.page.getByRole('list', { name: 'Shared with you' })).toHaveCount(0, { timeout: SLOW })
    await row(bea.page, 'Sol').click()
    await fill(bea.page, 'Name', 'Helios')
    await expect(row(bea.page, 'Helios')).toBeVisible()
    // Longer than a round and a nudge take while someone else is in (3 s, and under 1 s).
    await ana.page.waitForTimeout(5000)
    await expect(row(ana.page, 'Sol')).toBeVisible()
  } finally {
    await Promise.all([ana.close(), bea.close()])
    for (const proxy of [toAna, toBea]) (await proxy.server).close()
  }
})
