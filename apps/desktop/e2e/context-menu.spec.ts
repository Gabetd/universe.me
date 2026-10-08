import type { Page } from '@playwright/test'
import { drawRegion, expect, inspector, newWorld, openMap, row, shot, state, test } from './helpers'

const menu = (page: Page) => page.getByRole('menu')

test('right-clicking anything gives its options: in the tree, on the timeline, on the map and in the inspector’s lists', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Aerth')

  // A node in the universe tree: open it, rename it, add to it, delete it.
  await row(page, 'Sol').click({ button: 'right' })
  await expect(menu(page)).toHaveAccessibleName('Star System · Sol')
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Open', 'Rename…', 'Add planet', 'Delete Sol'])
  await shot(page, '140-context-menu')
  await menu(page).getByRole('menuitem', { name: 'Add planet' }).click()
  await expect(menu(page)).toHaveCount(0)
  await expect.poll(async () => (await state(page, 'nodes')).filter((n) => n.kind === 'body').map((n) => n.name)).toEqual(['Terra', 'New Planet'])

  // Rename… opens it and puts the cursor in its name.
  await row(page, 'New Planet').click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Rename…' }).click()
  const name = inspector(page).getByLabel('Name', { exact: true })
  await expect(name).toBeFocused()
  await page.keyboard.type('Marrs')
  await page.keyboard.press('Enter')
  await expect(row(page, 'Marrs')).toHaveCount(1)

  // Escape, or a click elsewhere, closes it; the arrow keys move through it.
  await row(page, 'Marrs').click({ button: 'right' })
  await expect(menu(page).getByRole('menuitem', { name: 'Open' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu(page).getByRole('menuitem', { name: 'Rename…' })).toBeFocused()
  const selected = await page.locator('.tree-row.selected').textContent()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  // That Escape was the menu's: it didn't also zoom out a level, nor did Delete delete what's selected.
  await expect(page.locator('.tree-row.selected')).toHaveText(selected!)
  await row(page, 'Marrs').click({ button: 'right' })
  await page.keyboard.press('Delete')
  await expect(row(page, 'Marrs')).toHaveCount(1)
  await page.locator('.panel-title').click()
  await expect(menu(page)).toHaveCount(0)

  // Deleted from its menu, and back with one undo.
  await row(page, 'Marrs').click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Delete Marrs' }).click()
  await expect(row(page, 'Marrs')).toHaveCount(0)
  await page.getByRole('button', { name: '↶ Undo' }).click()
  await expect(row(page, 'Marrs')).toHaveCount(1)

  // An event on the timeline.
  await row(page, 'Terra Surface').click()
  await page.getByRole('button', { name: '+ Event' }).click()
  const event = page.locator('.tl-event').first()
  await event.click({ button: 'right' })
  await expect(menu(page)).toHaveAccessibleName(/^Event · /)
  await expect(menu(page).getByRole('menuitem', { name: 'Move the playhead here' })).toBeVisible()
  await menu(page).getByRole('menuitem', { name: /^Delete / }).click()
  await expect.poll(async () => (await state(page, 'timeline')).events.length).toBe(0)

  // A region on the map, and the same region in the world's list.
  await openMap(page)
  await drawRegion(page)
  await expect.poll(async () => (await state(page, 'regions')).map((r) => r.name)).toEqual(['New Region'])
  const map = (await page.getByTestId('map').boundingBox())!
  const [rx, ry] = [map.x + map.width * 0.26, map.y + map.height * 0.35]
  // A right-drag pans the map: no menu for what it started over.
  await page.mouse.move(rx, ry)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(rx + 60, ry + 20, { steps: 5 })
  await page.mouse.up({ button: 'right' })
  await expect(menu(page)).toHaveCount(0)
  // And back, so the region is under the pointer again.
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(rx, ry, { steps: 5 })
  await page.mouse.up({ button: 'right' })
  await expect(menu(page)).toHaveCount(0)
  await page.mouse.click(rx, ry, { button: 'right' })
  await expect(menu(page)).toHaveAccessibleName('Region · New Region')
  await menu(page).getByRole('menuitem', { name: 'Rename…' }).click()
  await expect(inspector(page).getByLabel('Region name')).toBeFocused()
  await page.keyboard.press('Escape')
  await inspector(page).getByRole('region', { name: 'Regions' }).getByRole('button', { name: 'New Region' }).click({ button: 'right' })
  await expect(menu(page)).toHaveAccessibleName('Region · New Region')
  await page.keyboard.press('Escape')
})
