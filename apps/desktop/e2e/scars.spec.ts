import type { Page } from '@playwright/test'
import { expect, inspector, newWorld, openMap, patch, setPlayhead, shot, SLOW, state, test } from './helpers'

const scars = async (page: Page) => (await state(page, 'timeline')).scars
const menu = (page: Page) => page.getByRole('menu')

/** The nearest point to the middle of the map (as fractions of it) with land all round it: green or tan, not sea or ice. */
const landOnMap = (page: Page) =>
  page.getByTestId('map').evaluate((canvas: HTMLCanvasElement) => {
    const copy = document.createElement('canvas')
    ;[copy.width, copy.height] = [canvas.width, canvas.height]
    const ctx = copy.getContext('2d')!
    ctx.drawImage(canvas, 0, 0)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const land = (x: number, y: number) => {
      const i = (Math.round(y) * canvas.width + Math.round(x)) * 4
      const [r, g, b] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!]
      return g > b + 12 && r + g + b < 600
    }
    // As wide a patch of land as there is: a smaller one where the land is broken up.
    let best: [number, number] | undefined
    for (const share of [0.02, 0.012, 0.006]) {
      const r = Math.round(canvas.width * share)
      for (let fy = 0.3; fy <= 0.7; fy += 0.01)
        for (let fx = 0.2; fx <= 0.8; fx += 0.01) {
          const [x, y] = [fx * canvas.width, fy * canvas.height]
          // Every pixel around it: no river through it either.
          let all = true
          for (let i = -r; i <= r && all; i += 2) for (let j = -r; j <= r && all; j += 2) all = land(x + i, y + j)
          if (all && (!best || Math.hypot(fx - 0.5, fy - 0.5) < Math.hypot(best[0] - 0.5, best[1] - 0.5))) best = [fx, fy]
        }
      if (best) break
    }
    if (!best) throw new Error('No land on the map')
    return best
  })

test('scars on the land: a drought left with the tool parches the map where it reaches, healing after its end; a crater left from the menu, seen up close on the ground', async ({ h }) => {
  // The ground is drawn in software on CI machines.
  test.slow()
  const { page } = h
  await newWorld(h, 'Scorched')
  await openMap(page)
  const map = (await page.getByTestId('map').boundingBox())!
  const land = await landOnMap(page)
  const at: [number, number] = [map.x + map.width * land[0], map.y + map.height * land[1]]
  const before = await patch(page, 'map', land, 0.01)

  // The tool: a great drought where the map is clicked, at the playhead.
  await page.getByRole('toolbar', { name: 'World tools' }).getByRole('button', { name: 'Scar the land' }).click()
  const options = page.getByRole('complementary', { name: 'Tool options' })
  await options.getByRole('radio', { name: 'Drought' }).click()
  await options.getByLabel('Scar size').focus()
  await page.keyboard.press('End')
  await expect(options).toContainText('2000 km')
  await page.mouse.click(...at)
  await expect.poll(async () => (await scars(page)).map((s) => [s.kind, s.radiusKm, s.end])).toEqual([['drought', 2000, null]])
  const panel = inspector(page).getByRole('region', { name: 'Scar', exact: true })
  await expect(panel.getByLabel('Scar now')).toHaveText('At its worst, at the playhead.')
  // The land it covers parched: paler and yellower than it was.
  await expect.poll(async () => (await patch(page, 'map', land, 0.01))[0], { timeout: SLOW }).toBeGreaterThan(before[0] + 15)
  await shot(page, '250-scar-drought')

  // Named and ended as it came: a year on (it heals over three), much of it is gone.
  await panel.getByLabel('Scar name').fill('The Long Thirst')
  await panel.getByLabel('Scar name').press('Enter')
  await panel.getByLabel('Worst until').fill('0')
  await panel.getByLabel('Worst until').press('Enter')
  await expect.poll(async () => (await scars(page))[0]).toMatchObject({ name: 'The Long Thirst', end: 0, recoverYears: 3 })
  await setPlayhead(page, '1')
  await expect(panel.getByLabel('Scar now')).toHaveText(/^Healing, at the playhead: \d+% of it left\.$/)
  await expect(inspector(page).getByRole('region', { name: 'Scars on the land' })).toContainText('The Long Thirst')

  // From the menu: a crater, where the land is right-clicked (on the drought's icon, which says what's there).
  await page.keyboard.press('Escape')
  await page.getByRole('toolbar', { name: 'World tools' }).getByRole('button', { name: 'Scar the land' }).click()
  await options.getByRole('radio', { name: 'Crater' }).click()
  await page.getByRole('toolbar', { name: 'World tools' }).getByRole('button', { name: 'Navigate' }).click()
  await page.mouse.click(...at, { button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Leave a scar here (crater)…' }).click()
  await expect.poll(async () => (await scars(page)).map((s) => s.kind).sort()).toEqual(['crater', 'drought'])
  await expect(panel.getByLabel('Kind of scar')).toHaveValue('crater')

  // Up close: the ground opens over it.
  await page.getByRole('button', { name: '🔍 Ground' }).click()
  await expect(page.locator('[data-chunks="25"]')).toBeVisible({ timeout: SLOW })
  await shot(page, '251-scar-crater', { views: false })
})
