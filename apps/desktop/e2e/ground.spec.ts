import type { Page } from '@playwright/test'
import { addChild, expect, inspector, newWorld, openMap, row, setPlayhead, SLOW, test, wheel } from './helpers'

/** A spot of green land on the map near its middle, in CSS pixels from the map's corner. */
function landNear(page: Page): Promise<[number, number]> {
  return page.getByTestId('map').evaluate((el) => {
    const canvas = el as HTMLCanvasElement
    const ctx = canvas.getContext('2d')!
    const dpr = canvas.width / canvas.clientWidth
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let best: [number, number] = [canvas.clientWidth / 2, canvas.clientHeight / 2]
    let bestD = Infinity
    for (let y = 0; y < height; y += 3) {
      for (let x = 0; x < width; x += 3) {
        const o = (y * width + x) * 4
        const [r, g, b] = [data[o]!, data[o + 1]!, data[o + 2]!]
        // Forest or grassland green, well inside the land (its neighbours green too).
        const green = (i: number) => data[i + 1]! > data[i]! + 15 && data[i + 1]! > data[i + 2]! + 15
        if (!(g > r + 15 && g > b + 15) || !green(o + 12 * 4) || !green(o - 12 * 4) || !green(o + 12 * width * 4) || !green(o - 12 * width * 4)) continue
        const d = Math.hypot(x - width / 2, y - height * 0.45)
        if (d < bestD) [bestD, best] = [d, [x / dpr, y / dpr]]
      }
    }
    return best
  })
}

test('planets show their surface, structures are pins from afar, and the ground up close', async ({ h }) => {
  // Thousands of trees and a whole city, drawn in software on CI machines: slow, but it's the point.
  test.setTimeout(240_000)
  const { page } = h
  await newWorld(h, 'Close', { surface: false })
  await addChild(page, '+ Moon', 'Luna')
  await addChild(page, '+ World surface', 'Luna Surface')
  await row(page, 'Terra').click()
  await addChild(page, '+ World surface', 'Terra Surface')

  // From orbit, Terra and its moon show their real surfaces.
  await row(page, 'Terra').click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: 'test-results/60-orbit-surfaces.png' })

  await row(page, 'Terra Surface').click()
  await openMap(page)
  await setPlayhead(page, '1000')
  await page.getByRole('button', { name: 'Place structure' }).click()
  await page.getByLabel('Blueprint to place').selectOption({ label: 'Walled city (vast)' })
  const map = (await page.getByTestId('map').boundingBox())!
  const [lx, ly] = await landNear(page)
  await page.mouse.click(map.x + lx, map.y + ly)
  await page.keyboard.press('Escape')
  await expect(inspector(page).getByLabel('Structure name')).toHaveValue('Walled city (vast)')

  // From afar, a pin.
  await page.getByRole('button', { name: '🌐 Globe' }).click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'test-results/61-globe-pins.png' })

  // Down to the ground at the city.
  await page.getByRole('button', { name: '🔍 Ground' }).click()
  await expect(page.locator('[data-chunks="25"]')).toBeVisible({ timeout: SLOW })
  await page.waitForTimeout(1000)
  await page.screenshot({ path: 'test-results/62-ground.png' })
  await wheel(page, page.getByTestId('ground'), -300, 4)
  await page.waitForTimeout(1000)
  await page.screenshot({ path: 'test-results/63-ground-close.png' })

  // How fast it draws, for the record.
  const fps = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0
        const t0 = performance.now()
        const tick = () => (++frames < 5 ? requestAnimationFrame(tick) : resolve((frames * 1000) / (performance.now() - t0)))
        requestAnimationFrame(tick)
      })
  )
  console.log(`ground view: ${fps.toFixed(1)} fps`)

  // Back up to the globe.
  await page.getByRole('button', { name: '⬆ Back up' }).click()
  await expect(page.getByTestId('globe')).toBeVisible()
})
