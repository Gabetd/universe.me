import { expect, test, type Page } from '@playwright/test'
import { addChild, inspector, launch, newProject, row, type AppHandle } from './helpers'

let h: AppHandle
test.beforeEach(async () => {
  h = await launch()
})
test.afterEach(async () => {
  await h?.close()
})

const state = (page: Page) => page.evaluate(async () => (await window.universe.getState()).timeline)

async function setPlayhead(page: Page, value: string) {
  const playhead = page.getByRole('toolbar', { name: 'Timeline' }).getByLabel('Playhead')
  await playhead.fill(value)
  await playhead.press('Enter')
}

test('themes: a library from presets, spans on the timeline that crossfade at the playhead, edited, moved and deleted', async () => {
  test.setTimeout(120_000)
  const { page } = h
  await newProject(h, 'Ages')
  await addChild(page, '+ Galaxy Cluster', 'Virgo')
  await addChild(page, '+ Galaxy', 'Milky Way')
  await addChild(page, '+ Star System', 'Sol')
  await addChild(page, '+ Planet', 'Terra')
  await addChild(page, '+ World surface', 'Terra Surface')
  const themes = inspector(page).getByRole('region', { name: 'Themes' })
  await expect(themes).toContainText('No theme at the playhead')

  // A Golden Age from the playhead (year 0) for a century, fading in and out over ten years.
  await themes.getByLabel('Start a theme from').selectOption('Golden Age')
  await themes.getByRole('button', { name: 'New theme from the playhead' }).click()
  await expect(inspector(page).getByRole('region', { name: 'Theme span' })).toBeVisible()
  const band = page.getByLabel('Theme spans')
  await expect(band.getByRole('button', { name: /^Theme span Golden Age/ })).toBeVisible()
  let tl = await state(page)
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
  tl = await state(page)
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
  await page.screenshot({ path: 'test-results/110-themes-crossfade.png' })
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
  await expect.poll(async () => (await state(page)).themes.find((t) => t.name === 'The Long Winter')?.lighting).toBe('night')
  await expect(band.getByRole('button', { name: /^Theme span The Long Winter/ })).toBeVisible()
  await page.screenshot({ path: 'test-results/111-theme-editor.png' })

  // Dragging a span along the band moves it in time.
  await page.getByRole('toolbar', { name: 'Timeline' }).getByRole('button', { name: 'Fit' }).click()
  const bar = band.getByRole('button', { name: /^Theme span Golden Age/ })
  const box = (await bar.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await state(page)).themeSpans.find((s) => s.id === golden.id)!.start).toBeGreaterThan(golden.start)

  // Deleting a theme (opened from the world's library) takes its spans; undo brings them back.
  await row(page, 'Terra Surface').click()
  await themes.getByRole('button', { name: 'The Long Winter', exact: true }).click()
  await editor.getByRole('button', { name: /^Delete theme/ }).click()
  await expect.poll(async () => (await state(page)).themeSpans.length).toBe(1)
  await page.getByRole('button', { name: /Undo/ }).click()
  await expect.poll(async () => (await state(page)).themeSpans.length).toBe(2)
})
