import type { Page } from '@playwright/test'
import { expect, httpMcp, inspector, newWorld, openMap, setPlayhead, shot, SLOW, state, test, tool } from './helpers'

/** A sum of the map's pixels: changes when anything drawn on it does. */
const mapPrint = (page: Page) =>
  page.getByTestId('map').evaluate((canvas: HTMLCanvasElement) => {
    const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
    let sum = 0
    for (let i = 0; i < data.length; i += 4) sum = (sum + data[i]! * 3 + data[i + 1]! * 5 + data[i + 2]! * 7) % 1_000_000_007
    return sum
  })

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

  // An AI sees the same rivers by the same ids (worked out in the app's own worker), and can name a lake.
  const mcp = httpMcp(h)
  await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
  const worldId = (await state(page, 'nodes')).find((n) => n.kind === 'world')!.id
  const named = await tool(mcp, 'list_waterways', { worldId, named: true })
  expect(named.riverList).toEqual([expect.objectContaining({ name: 'Silverrun', madeAs: generated })])
  const lakes = await tool(mcp, 'list_waterways', { worldId, kind: 'lake', limit: 1 })
  const lakeRows = water.getByRole('group', { name: 'Lakes' }).locator('.region-row')
  await expect(lakeRows.first()).toHaveText(lakes.lakeList[0].name)
  await tool(mcp, 'name_waterway', { worldId, key: lakes.lakeList[0].id, name: 'Mirrormere' })
  await expect(lakeRows.first()).toHaveText('Mirrormere')

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

test('the water is worked out again as the land changes, and the land wears down as time passes', async ({ h }) => {
  test.slow()
  const { page } = h
  await newWorld(h, 'Erosion')
  await openMap(page)
  const counts = inspector(page).getByRole('region', { name: 'Rivers and lakes' }).getByText(/ rivers and /)
  await expect(counts).toBeVisible({ timeout: SLOW })
  const before = await counts.textContent()

  // A higher sea drowns the lowlands and the rivers in them.
  const sea = inspector(page).getByRole('slider', { name: 'Sea level change' })
  await sea.focus()
  for (let i = 0; i < 10; i++) await sea.press('ArrowRight')
  await page.locator('.panel-title').click()
  await expect(counts).not.toHaveText(before!, { timeout: SLOW })

  // Thousands of years on, the land is worn down (rivers' valleys, slumped slopes); back at the start, it's as it was.
  const start = await mapPrint(page)
  await setPlayhead(page, '20000')
  await expect.poll(() => mapPrint(page), { timeout: SLOW }).not.toBe(start)
  await shot(page, '152-eroded-map', { wait: 500 })
  await setPlayhead(page, '0')
  await expect.poll(() => mapPrint(page), { timeout: SLOW }).toBe(start)
})
