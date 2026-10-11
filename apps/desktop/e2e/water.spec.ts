import { expect, inspector, newWorld, openMap, shot, SLOW, test } from './helpers'

test('a world has rivers and lakes from its land, each named, selectable and seen up close', async ({ h }) => {
  test.slow()
  const { page } = h
  await newWorld(h, 'Rivers')
  await openMap(page)

  // Worked out in a worker once the terrain is there: listed in the inspector, the biggest first.
  const water = inspector(page).getByRole('region', { name: 'Rivers and lakes' })
  const rivers = water.getByRole('group', { name: 'Rivers' }).locator('.region-row')
  await expect(rivers.first()).toBeVisible({ timeout: SLOW })
  await expect(water.getByRole('group', { name: 'Lakes' }).locator('.region-row').first()).toBeVisible()
  await shot(page, '150-rivers-map', { wait: 500 })

  // Picking a river opens it: its name from the seed, how long it is and where it runs.
  const generated = (await rivers.first().textContent())!.trim()
  await rivers.first().click()
  const panel = inspector(page).getByRole('region', { name: 'River', exact: true })
  await expect(panel.getByLabel('River name')).toHaveValue(generated)
  await expect(panel.getByRole('definition').first()).toContainText('km')

  // Given a name of its own, it keeps it (and says what it was called), and undo gives the old one back.
  await panel.getByLabel('River name').fill('Silverrun')
  await panel.getByLabel('River name').press('Enter')
  await expect(rivers.first()).toHaveText('Silverrun')
  await expect(panel).toContainText(`Named ${generated} when the world was made.`)
  await page.getByRole('button', { name: '↶ Undo' }).click()
  await expect(rivers.first()).toHaveText(generated)
  await page.getByRole('button', { name: '↷ Redo' }).click()
  await expect(rivers.first()).toHaveText('Silverrun')

  // Its menu gives it its own name back, or a new one.
  const menu = page.getByRole('menu')
  await rivers.first().click({ button: 'right' })
  await menu.getByRole('menuitem', { name: `Call it ${generated} again` }).click()
  await expect(rivers.first()).toHaveText(generated)
  await rivers.first().click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Rename…' }).click()
  await expect(panel.getByLabel('River name')).toBeFocused()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('Silverrun')
  await page.keyboard.press('Enter')
  await expect(rivers.first()).toHaveText('Silverrun')

  // On the map, clicking a river (drawn in its colour) opens it.
  const map = page.getByTestId('map')
  const spot = await map.evaluate((canvas: HTMLCanvasElement) => {
    const { data, width, height } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
    const dpr = width / canvas.clientWidth
    let best: [number, number] | null = null
    let bestD = Infinity
    for (let y = 0; y < height; y += 2)
      for (let x = 0; x < width; x += 2) {
        const o = (y * width + x) * 4
        // The river colour, #5aa9e6.
        if (Math.abs(data[o]! - 0x5a) > 10 || Math.abs(data[o + 1]! - 0xa9) > 10 || Math.abs(data[o + 2]! - 0xe6) > 10) continue
        const d = Math.hypot(x - width / 2, y - height / 2)
        if (d < bestD) [best, bestD] = [[x / dpr, y / dpr], d]
      }
    return best
  })
  expect(spot).not.toBeNull()
  const box = (await map.boundingBox())!
  await page.mouse.click(box.x + spot![0], box.y + spot![1])
  await expect(inspector(page).getByRole('region', { name: /^(River|Lake)$/ })).toBeVisible()

  // Up close: down to the ground at its middle, where it runs over the land.
  await rivers.first().click()
  await panel.getByRole('button', { name: '🔍 View up close' }).click()
  await expect(page.locator('[data-chunks="25"]')).toBeVisible({ timeout: SLOW })
  await shot(page, '151-river-ground', { wait: 1500 })
})
