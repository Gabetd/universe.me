import type { Page } from '@playwright/test'
import { clickAt, drag, expect, fill, inspector, newWorld, openGlobe, openMap, setPlayhead, shot, state, test } from './helpers'

const shows = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => (el instanceof HTMLCanvasElement ? el : el.querySelector('canvas')!).dataset.theme ?? '')
const eventBar = (page: Page, title: string) => page.locator('.tl-event', { hasText: title })

/**
 * The main flow from end to end (PLAN.md §10): a world, painted; a structure
 * on it; two events, one leading to the other, the second destroying it; a
 * theme over those years; then the playhead moved through them, and the views
 * showing each moment.
 */
test('the main flow: a world painted, a castle built, events that lead to its fall, a theme over them, and the views at each moment', async ({ h }) => {
  test.slow()
  const { page } = h
  await newWorld(h, 'Main flow')
  await openMap(page)

  // Paint a desert.
  const revision = async () => (await state(page, 'worlds'))[0]!.terrainRevision
  const before = await revision()
  await page.keyboard.press('b')
  await page.getByRole('radio', { name: 'Desert' }).click()
  await drag(page, 'map', [0.6, 0.4], [0.7, 0.42])
  await expect.poll(revision).toBeGreaterThan(before)

  // A castle, built in 1000.
  await setPlayhead(page, '1000')
  await page.keyboard.press('p')
  await page.getByLabel('Blueprint to place').selectOption({ label: 'Stone castle' })
  await clickAt(page, 'map', [0.5, 0.45])
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await state(page, 'timeline')).structures.map((s) => s.name)).toEqual(['Stone castle'])

  // A siege in 1200 leads to the castle's fall in 1210, which destroys it.
  await setPlayhead(page, '1200')
  await page.keyboard.press('n')
  await fill(page, 'Event title', 'The Siege')
  await setPlayhead(page, '1210')
  await page.keyboard.press('n')
  await fill(page, 'Event title', 'The Fall')
  await inspector(page).getByRole('button', { name: '+ Effect' }).click()
  await inspector(page).getByLabel('Effect', { exact: true }).selectOption('destroy')
  await inspector(page).getByLabel('Structures').getByLabel('Stone castle').check()
  await eventBar(page, 'The Siege').click()
  await inspector(page).getByLabel('Link to event').selectOption({ label: 'The Fall' })
  await expect.poll(async () => (await state(page, 'timeline')).links.length).toBe(1)

  // An age of war over those years.
  await setPlayhead(page, '1150')
  const themes = inspector(page).getByRole('region', { name: 'Themes' })
  await page.locator('.tree-row.selected').click()
  await themes.getByLabel('Start a theme from').selectOption('Age of War')
  await themes.getByRole('button', { name: 'New theme from the playhead' }).click()
  await expect.poll(async () => (await state(page, 'timeline')).themeSpans.length).toBe(1)

  // Through the years: before the siege the castle stands and the war is on the map; after its fall, it's gone.
  const castle = () => page.locator('.region-row', { hasText: 'Stone castle' })
  await setPlayhead(page, '1205')
  await castle().click()
  await expect(inspector(page).getByTestId('condition')).toHaveText(/Pristine|Weathered/)
  await expect.poll(() => shows(page, 'map')).toBe('Age of War')
  await setPlayhead(page, '1220')
  await expect(inspector(page).getByTestId('condition')).toHaveText('Gone')
  // And on the globe.
  await openGlobe(page)
  await expect.poll(() => shows(page, 'globe')).toBe('Age of War')
  await shot(page, '210-main-flow')
})
