import { expect, test, type Page } from '@playwright/test'
import { addChild, inspector, launch, newProject, type AppHandle } from './helpers'

let h: AppHandle
test.beforeEach(async () => {
  h = await launch()
})
test.afterEach(async () => {
  await h?.close()
})

const records = (page: Page) => page.evaluate(async () => (await window.universe.getState()).timeline)

async function fill(page: Page, label: string, value: string) {
  const input = inspector(page).getByLabel(label, { exact: true })
  await input.fill(value)
  await input.press('Enter')
}

async function setPlayhead(page: Page, value: string) {
  const playhead = page.getByRole('toolbar', { name: 'Timeline' }).getByLabel('Playhead')
  await playhead.fill(value)
  await playhead.press('Enter')
}

test('place structures, weather them, and let events damage and destroy them', async () => {
  const { page } = h
  await newProject(h, 'Kingdoms')
  await addChild(page, '+ Galaxy Cluster', 'Virgo')
  await addChild(page, '+ Galaxy', 'Milky Way')
  await addChild(page, '+ Star System', 'Sol')
  await addChild(page, '+ Planet', 'Terra')
  await addChild(page, '+ World surface', 'Terra Surface')
  await page.getByRole('button', { name: '🗺 Map' }).click()
  await expect(page.getByText('Generating terrain…')).toHaveCount(0, { timeout: 20_000 })
  // Measured at each click: tool options in the toolbar can move the map.
  const at = async (x: number, y: number) => {
    const map = (await page.getByTestId('map').boundingBox())!
    await page.mouse.click(map.x + map.width * x, map.y + map.height * y)
  }

  // Place a castle and a house in the year 1000.
  await setPlayhead(page, '1000')
  await page.getByRole('button', { name: 'Place structure' }).click()
  await page.getByLabel('Blueprint to place').selectOption({ label: 'Stone castle' })
  await at(0.5, 0.45)
  await page.getByLabel('Blueprint to place').selectOption({ label: 'House' })
  await at(0.505, 0.46)
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await records(page)).structures.map((s) => s.name)).toEqual(['Stone castle', 'House'])
  await expect(inspector(page).getByTestId('condition')).toHaveText('100 · Pristine')

  // The house is abandoned in 1100; by 1180 it has weathered, and a wood-and-thatch house is gone by 1400.
  await setPlayhead(page, '1100')
  await inspector(page).getByLabel(/Maintained from/).uncheck()
  await setPlayhead(page, '1180')
  await expect(inspector(page).getByTestId('condition')).not.toHaveText(/Pristine/)
  await expect(inspector(page).getByText(/erodes away around/)).toBeVisible()
  await setPlayhead(page, '1400')
  await expect(inspector(page).getByTestId('condition')).toHaveText('Gone')

  // A siege in 1250 at the castle damages everything within 100 km, less with distance.
  await setPlayhead(page, '1250')
  await page.getByRole('button', { name: '+ Event' }).click()
  await fill(page, 'Event title', 'The Siege')
  await inspector(page).getByRole('button', { name: '📍 Pick on map' }).click()
  await at(0.5, 0.45)
  await inspector(page).getByRole('button', { name: '+ Effect' }).click()
  await inspector(page).getByLabel('Effect', { exact: true }).selectOption('damage')
  await inspector(page).getByLabel('Reaches', { exact: true }).selectOption('radius')
  await fill(page, 'Radius (km)', '400')
  await expect(inspector(page).getByText(/Reaches 2 structures/)).toBeVisible()
  await page.screenshot({ path: 'test-results/40-effect-preview.png' })

  await page.locator('.region-row', { hasText: 'Stone castle' }).click()
  await expect(inspector(page).getByTestId('condition')).toHaveText(/^60 · Weathered/)
  await expect(inspector(page).getByText('The Siege')).toBeVisible()

  // Later the castle is destroyed outright; it's gone at the playhead.
  await setPlayhead(page, '1400')
  await page.getByRole('button', { name: '+ Event' }).click()
  await fill(page, 'Event title', 'The Fall')
  await inspector(page).getByRole('button', { name: '+ Effect' }).click()
  await inspector(page).getByLabel('Effect', { exact: true }).selectOption('destroy')
  await inspector(page).getByLabel('Structures').getByLabel('Stone castle').check()
  await page.locator('.region-row', { hasText: 'Stone castle' }).click()
  await expect(inspector(page).getByTestId('condition')).toHaveText('Gone')
  await page.getByRole('button', { name: '🌐 Globe' }).click()
  await setPlayhead(page, '1260')
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'test-results/41-structures-globe.png' })
  // Up close.
  const globe = (await page.getByTestId('globe').boundingBox())!
  await page.mouse.move(globe.x + globe.width / 2, globe.y + globe.height / 2)
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -400)
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'test-results/42-structures-close.png' })
})
