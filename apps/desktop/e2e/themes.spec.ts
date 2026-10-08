import type { Page } from '@playwright/test'
import { drawRegion, expect, inspector, newWorld, openGlobe, openMap, row, setPlayhead, shot, state, test, viewReady, type Fraction } from './helpers'

const timeline = (page: Page) => state(page, 'timeline')

/** The mean colour (0–255 a channel) of a patch of a view's canvas, `size` of it across, centred at a fraction of it. */
const patch = (page: Page, testId: string, at: Fraction, size = 0.06) =>
  page.getByTestId(testId).evaluate(
    (el, [fx, fy, size]) => {
      const source = el instanceof HTMLCanvasElement ? el : el.querySelector('canvas')!
      const copy = document.createElement('canvas')
      copy.width = source.width
      copy.height = source.height
      const ctx = copy.getContext('2d')!
      ctx.drawImage(source, 0, 0)
      const [w, h] = [Math.max(1, Math.round(source.width * size)), Math.max(1, Math.round(source.height * size))]
      const data = ctx.getImageData(Math.round(source.width * fx - w / 2), Math.round(source.height * fy - h / 2), w, h).data
      const sum = [0, 0, 0]
      for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) sum[c]! += data[i + c]!
      return sum.map((v) => v / (w * h)) as [number, number, number]
    },
    [at[0], at[1], size] as const
  )
const brightness = ([r, g, b]: [number, number, number]) => (r + g + b) / 3
const apart = (a: [number, number, number], b: [number, number, number]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)))
/** The theme a view says it shows. */
const shows = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => (el instanceof HTMLCanvasElement ? el : el.querySelector('canvas')!).dataset.theme ?? '')

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
  const accent = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))
  await setPlayhead(page, '-50')
  await expect.poll(accent).toBe('')
  await setPlayhead(page, '50')
  await expect(now).toContainText('Golden Age')
  await expect(now).not.toContainText('Plague')
  // The interface takes on the theme's accent.
  await expect.poll(accent).toBe('#e0a526')
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

test('the views take on the theme in force: its light and colours on the globe, the map and the ground, and a region its own', async ({ h }) => {
  test.slow()
  const { page } = h
  await newWorld(h, 'Seasons')
  const themes = inspector(page).getByRole('region', { name: 'Themes' })
  await openGlobe(page)
  const planet = () => patch(page, 'globe', [0.5, 0.5], 0.2)
  const plain = await planet()
  expect(await shows(page, 'globe')).toBe('')

  // An Age of War from year 0 to 100: a stormy light, hazier air. At its height the globe is darker.
  await themes.getByLabel('Start a theme from').selectOption('Age of War')
  await themes.getByRole('button', { name: 'New theme from the playhead' }).click()
  await setPlayhead(page, '50')
  await expect.poll(() => shows(page, 'globe')).toBe('Age of War')
  await expect.poll(async () => brightness(await planet())).toBeLessThan(brightness(plain) * 0.9)
  await shot(page, '112-theme-globe')
  // Before it begins, the globe is as it was.
  await setPlayhead(page, '-50')
  await expect.poll(() => shows(page, 'globe')).toBe('')
  await expect.poll(async () => apart(await planet(), plain)).toBeLessThan(3)

  // The map is shaded by it too.
  await openMap(page)
  const land = () => patch(page, 'map', [0.7, 0.6])
  const unshaded = await land()
  await setPlayhead(page, '50')
  await expect.poll(() => shows(page, 'map')).toBe('Age of War')
  await expect.poll(async () => brightness(await land())).toBeLessThan(brightness(unshaded) * 0.9)

  // An Ice Age over it from year 50, first over the whole world, then only in a region.
  await drawRegion(page)
  await expect.poll(async () => (await state(page, 'regions')).length).toBe(1)
  await row(page, 'Terra Surface').click()
  await themes.getByLabel('Start a theme from').selectOption('Ice Age')
  await themes.getByRole('button', { name: 'New theme from the playhead' }).click()
  await setPlayhead(page, '80')
  await expect.poll(() => shows(page, 'map')).toBe('Ice Age')
  await viewReady(page)
  const inside = () => patch(page, 'map', [0.26, 0.35], 0.03)
  const [iceInside, iceOutside] = [await inside(), await land()]
  await inspector(page).getByLabel('Where', { exact: true }).selectOption('New Region')
  await expect.poll(async () => (await timeline(page)).themeSpans.some((s) => s.regionId)).toBe(true)
  // Outside the region the world is back to the Age of War; inside it keeps its Ice Age.
  await expect.poll(() => shows(page, 'map')).toBe('Age of War')
  await expect.poll(async () => apart(await land(), iceOutside)).toBeGreaterThan(8)
  await expect.poll(async () => apart(await inside(), iceInside)).toBeLessThan(3)
  await shot(page, '113-theme-region')

  // On the ground, the light and sky are the theme's where it stands.
  await page.getByRole('button', { name: '🔍 Ground' }).click()
  await expect(page.getByTestId('ground')).toBeVisible()
  await viewReady(page)
  expect(await shows(page, 'ground')).toBe('Age of War')
  const sky = await patch(page, 'ground', [0.5, 0.03], 0.02)
  await setPlayhead(page, '-50')
  await expect.poll(() => shows(page, 'ground')).toBe('')
  await expect.poll(async () => apart(await patch(page, 'ground', [0.5, 0.03], 0.02), sky)).toBeGreaterThan(8)
})
