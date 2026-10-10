import { join } from 'node:path'
import { expect, inspector, playhead, shot, state, stubSaveDialog, test } from './helpers'

test('keyboard shortcuts: the sheet lists them, and views, tools and the timeline answer to them', async ({ h }) => {
  const { app, page, dir } = h
  await stubSaveDialog(app, join(dir, 'Calder (sample).universe'))
  await page.getByRole('button', { name: 'Explore a sample universe' }).click()
  await expect(page.locator('.tree-row.selected')).toHaveText(/Calder Surface/)

  // ? shows them all; Esc closes it (and nothing else happens: the world stays selected).
  await page.keyboard.press('?')
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(sheet.getByRole('region', { name: 'World tools' })).toContainText('Raise land')
  await shot(page, '200-shortcuts', { views: false })
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(page.locator('.tree-row.selected')).toHaveText(/Calder Surface/)
  // The button says its key.
  await expect(page.getByRole('button', { name: '🗺 Map' })).toHaveAttribute('title', /\(2\)$/)

  // Views by number, tools by letter.
  await page.keyboard.press('2')
  await expect(page.getByRole('button', { name: '🗺 Map' })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('r')
  await expect(page.getByRole('button', { name: 'Raise', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('h')
  await expect(page.getByRole('button', { name: 'Navigate', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('5')
  await expect(page.getByRole('button', { name: '🦌 Species' })).toHaveAttribute('aria-pressed', 'true')

  // [ takes the playhead back to the event before it, and selects it.
  await expect(playhead(page)).toHaveValue(/1450/)
  await page.keyboard.press('[')
  await expect(playhead(page)).toHaveValue(/1402/)
  await expect(inspector(page).getByLabel('Event title')).toHaveValue('Eastwatch Light relit')
  await page.keyboard.press('[')
  await expect(playhead(page)).toHaveValue(/1290/)
  // N makes an event there; typing in a field leaves the keys alone.
  const before = (await state(page, 'timeline')).events.length
  await page.keyboard.press('n')
  await expect.poll(async () => (await state(page, 'timeline')).events.length).toBe(before + 1)
  await inspector(page).getByLabel('Event title').fill('n2r')
  await expect(page.getByRole('button', { name: '🦌 Species' })).toHaveAttribute('aria-pressed', 'true')
})
