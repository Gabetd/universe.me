import type { Page } from '@playwright/test'
import { expect, inspector, newWorld, openGlobe, openMap, shot, SLOW, state, test } from './helpers'

const menu = (page: Page) => page.getByRole('menu')
const pins = async (page: Page) => (await state(page, 'timeline')).mapPins.map((p) => p.name)

test('pins on the surface: right-click a point of the map, the globe or the ground, Add a pin here, name it; it shows there, opens with a click and is deleted from its menu', async ({ h }) => {
  // The ground is drawn in software on CI machines.
  test.slow()
  const { page } = h
  await newWorld(h, 'Aerth')

  // On the map: a point with nothing on it.
  await openMap(page)
  const map = (await page.getByTestId('map').boundingBox())!
  const [x, y] = [map.x + map.width * 0.6, map.y + map.height * 0.5]
  await page.mouse.click(x, y, { button: 'right' })
  await expect(menu(page)).toHaveAccessibleName(/°/)
  await menu(page).getByRole('menuitem', { name: 'Add a pin here…' }).click()
  const name = inspector(page).getByLabel('Pin name')
  await expect(name).toBeFocused()
  await name.fill('Old well')
  await name.press('Enter')
  await expect.poll(() => pins(page)).toEqual(['Old well'])
  await expect(inspector(page).getByLabel('Where')).toHaveText(/° [NS], .*° [EW]/)
  await shot(page, '243-map-pin')

  // A click elsewhere, then on the pin's head, opens it again; its menu deletes it (undoable).
  await page.keyboard.press('Escape')
  await page.mouse.click(x, y - 14)
  await expect(inspector(page).getByRole('region', { name: 'Pin' })).toBeVisible()
  await page.mouse.click(x, y - 14, { button: 'right' })
  await expect(menu(page)).toHaveAccessibleName('Pin · Old well')
  await menu(page).getByRole('menuitem', { name: 'Delete Old well' }).click()
  await expect.poll(() => pins(page)).toEqual([])
  await page.getByRole('button', { name: '↶ Undo' }).click()
  await expect.poll(() => pins(page)).toEqual(['Old well'])

  // On the globe: the middle of the planet.
  await openGlobe(page)
  const globe = (await page.getByTestId('globe').boundingBox())!
  await page.mouse.click(globe.x + globe.width / 2, globe.y + globe.height / 2, { button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Add a pin here…' }).click()
  await expect(inspector(page).getByLabel('Pin name')).toBeFocused()
  await inspector(page).getByLabel('Pin name').fill('Landing')
  await inspector(page).getByLabel('Pin name').press('Enter')
  await expect.poll(async () => (await pins(page)).sort()).toEqual(['Landing', 'Old well'])
  await expect(page.locator('.pin-label', { hasText: 'Landing' })).toBeAttached()

  // On the ground, up close: where the view looks.
  await page.getByRole('button', { name: '🔍 Ground' }).click()
  await expect(page.locator('[data-chunks="25"]')).toBeVisible({ timeout: SLOW })
  const ground = (await page.getByTestId('ground').boundingBox())!
  await page.mouse.click(ground.x + ground.width / 2, ground.y + ground.height * 0.6, { button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Add a pin here…' }).click()
  await inspector(page).getByLabel('Pin name').fill('Camp')
  await inspector(page).getByLabel('Pin name').press('Enter')
  await expect.poll(async () => (await pins(page)).sort()).toEqual(['Camp', 'Landing', 'Old well'])
})
