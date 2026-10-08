import type { Page } from '@playwright/test'
import { expect, inspector, newWorld, row, setPlayhead, shot, state, test } from './helpers'

const timeline = (page: Page) => state(page, 'timeline')

test('themes: a library from presets, spans on the timeline that crossfade at the playhead, edited, moved and deleted', async ({ h }) => {
  test.slow()
  const { page } = h
  await newWorld(h, 'Ages')
  const themes = inspector(page).getByRole('region', { name: 'Themes' })
  await expect(themes).toContainText('No theme at the playhead')

  // A Golden Age from the playhead (year 0) for a century, fading in and out over ten years.
  await themes.getByLabel('Start a theme from').selectOption('Golden Age')
  await themes.getByRole('button', { name: 'New theme from the playhead' }).click()
  await expect(inspector(page).getByRole('region', { name: 'Theme span' })).toBeVisible()
  const band = page.getByLabel('Theme spans')
  await expect(band.getByRole('button', { name: /^Theme span Golden Age/ })).toBeVisible()
  let tl = await timeline(page)
  expect(tl.themes.map((t) => t.name)).toEqual(['Golden Age'])
  expect(tl.themeSpans).toHaveLength(1)
  const golden = tl.themeSpans[0]!
  expect(golden.blendIn).toBeGreaterThan(0)

  // Then the Plague Years from year 80, overlapping the Golden Age's last twenty years.
  await row(page, 'Terra Surface').click()
  await setPlayhead(page, '80')
  await themes.getByLabel('Start a theme from').selectOption('Plague Years')
  await themes.getByRole('button', { name: 'New theme from the playhead' }).click()
  await expect(band.getByRole('button', { name: /^Theme span Plague Years/ })).toBeVisible()
  tl = await timeline(page)
  expect(tl.themeSpans).toHaveLength(2)

  // The playhead decides what's in force: one theme, both crossfading, then the other.
  await row(page, 'Terra Surface').click()
  const now = themes.locator('.theme-now')
  await setPlayhead(page, '50')
  await expect(now).toContainText('Golden Age')
  await expect(now).not.toContainText('Plague')
  await setPlayhead(page, '85')
  await expect(now).toContainText('Golden Age')
  await expect(now).toContainText('Plague Years')
  await themes.scrollIntoViewIfNeeded()
  await shot(page, '110-themes-crossfade')
  await setPlayhead(page, '150')
  await expect(now).toContainText('Plague Years')
  await expect(now).not.toContainText('Golden')

  // The theme editor: rename it, change its lighting; the band follows.
  await band.getByRole('button', { name: /^Theme span Plague Years/ }).click()
  await inspector(page).getByRole('button', { name: 'Edit Plague Years…' }).click()
  const editor = inspector(page).getByRole('region', { name: 'Theme', exact: true })
  const name = editor.getByLabel('Theme name')
  await name.fill('The Long Winter')
  await name.press('Enter')
  await editor.getByLabel('Lighting').selectOption('night')
  await expect.poll(async () => (await timeline(page)).themes.find((t) => t.name === 'The Long Winter')?.lighting).toBe('night')
  await expect(band.getByRole('button', { name: /^Theme span The Long Winter/ })).toBeVisible()
  await shot(page, '111-theme-editor')

  // Dragging a span along the band moves it in time.
  await page.getByRole('toolbar', { name: 'Timeline' }).getByRole('button', { name: 'Fit' }).click()
  const bar = band.getByRole('button', { name: /^Theme span Golden Age/ })
  const box = (await bar.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await timeline(page)).themeSpans.find((s) => s.id === golden.id)!.start).toBeGreaterThan(golden.start)

  // Deleting a theme (opened from the world's library) takes its spans; undo brings them back.
  await row(page, 'Terra Surface').click()
  await themes.getByRole('button', { name: 'The Long Winter', exact: true }).click()
  await editor.getByRole('button', { name: /^Delete theme/ }).click()
  await expect.poll(async () => (await timeline(page)).themeSpans.length).toBe(1)
  await page.getByRole('button', { name: /Undo/ }).click()
  await expect.poll(async () => (await timeline(page)).themeSpans.length).toBe(2)
})
