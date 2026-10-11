import type { Page } from '@playwright/test'
import { clickAt, expect, newWorld, openMap, state, test } from './helpers'

/** Holds the middle button over the middle of the map and drags `dy` pixels (up is negative). */
async function middleDrag(page: Page, dy: number) {
  const box = (await page.getByTestId('map').boundingBox())!
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
  await page.mouse.move(x, y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(x, y + dy / 2)
  await page.mouse.move(x, y + dy)
  await expect(page.getByRole('status', { name: 'Resizing' })).toBeVisible()
  await page.mouse.up({ button: 'middle' })
  await expect(page.getByRole('status', { name: 'Resizing' })).toBeHidden()
}

test('holding the middle button and dragging resizes the terrain brush while it is out, else the selected structure', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Sizes')
  await openMap(page)

  // The brush: up makes it bigger, down smaller.
  await page.getByRole('button', { name: 'Raise' }).click()
  const size = page.locator('.tool-options').getByRole('slider', { name: /^Size/ })
  await expect(size).toHaveValue('350')
  await middleDrag(page, -100)
  expect(Number(await size.inputValue())).toBeGreaterThan(550)
  await middleDrag(page, 200)
  expect(Number(await size.inputValue())).toBeLessThan(350)

  // A structure, selected: one step of undo.
  await page.getByRole('button', { name: 'Place structure' }).click()
  await clickAt(page, 'map', [0.5, 0.45])
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await state(page, 'timeline')).structures.length).toBe(1)
  await page.getByRole('button', { name: 'Navigate' }).click()
  await middleDrag(page, -120)
  await expect.poll(async () => (await state(page, 'timeline')).structures[0]!.scale).toBe(2)
  await page.getByRole('button', { name: '↶ Undo' }).click()
  await expect.poll(async () => (await state(page, 'timeline')).structures[0]!.scale).toBe(1)
})
