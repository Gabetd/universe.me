import { expect, newWorld, shot, SLOW, test } from './helpers'

test('on the ground, W A S D move over it at the speed picked, and S moves rather than picking Smooth', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Walking')
  await page.getByRole('button', { name: '🔍 Ground' }).click()
  await expect(page.locator('[data-chunks="25"]')).toBeVisible({ timeout: SLOW })
  const canvas = page.locator('[data-testid="ground"] canvas')
  /** Where the view looks: metres east and south of where it began. */
  const at = async () => (await canvas.getAttribute('data-at'))!.split(',').map(Number) as [number, number]
  const hold = async (key: string, ms: number) => {
    await page.keyboard.down(key)
    await page.waitForTimeout(ms)
    await page.keyboard.up(key)
  }

  // Run: far enough in a moment to measure, near enough to stay in the view's frame (it starts a new one 2.5 km out).
  await page.getByRole('radio', { name: 'Run' }).click()
  await shot(page, '64-ground-walk', { views: false })
  const start = await at()
  // The camera starts south of where it looks, so forward is north (smaller z).
  await hold('w', 600)
  const ahead = await at()
  expect(start[1] - ahead[1]).toBeGreaterThan(20)
  await hold('d', 600)
  expect((await at())[0] - ahead[0]).toBeGreaterThan(20)

  // S goes back, and the tool stays as it was.
  const before = await at()
  await hold('s', 600)
  expect((await at())[1] - before[1]).toBeGreaterThan(20)
  await expect(page.getByRole('button', { name: 'Navigate', exact: true })).toHaveAttribute('aria-pressed', 'true')

  // Slower when asked: walking covers less ground in the same time.
  await page.getByRole('radio', { name: 'Walk' }).click()
  const slow = await at()
  await hold('w', 600)
  const walked = slow[1] - (await at())[1]
  expect(walked).toBeGreaterThan(0)
  expect(walked).toBeLessThan(start[1] - ahead[1])
})

test('on the ground, the planet’s map in the corner shows where you are and which way you face, and a click on it goes there; the ground reaches 12 km', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Far')
  await page.getByRole('button', { name: '🔍 Ground' }).click()
  await expect(page.locator('[data-chunks="25"]')).toBeVisible({ timeout: SLOW })
  const minimap = page.getByTestId('ground-minimap')
  const at = async () => (await minimap.getAttribute('data-at'))!.split(',').map(Number)
  const heading = async () => Number(await minimap.getAttribute('data-heading'))
  await expect(minimap).toBeVisible()
  // The camera starts a little south of where it looks, facing north.
  await expect.poll(at).toEqual([expect.closeTo(-0.004, 2), expect.closeTo(0, 3)])
  expect(await heading()).toBe(0)
  // Looking out across it, the ground goes on to the haze.
  await page.getByRole('radio', { name: 'Fly' }).click()
  await shot(page, '65-ground-far', { views: false })

  // Turning the view (right-drag) turns the arrow.
  const view = (await page.locator('[data-testid="ground"] canvas').boundingBox())!
  const [x, y] = [view.x + view.width / 2, view.y + view.height / 2]
  await page.mouse.move(x, y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(x + 150, y, { steps: 5 })
  await page.mouse.up({ button: 'right' })
  await expect.poll(heading).not.toBe(0)

  // The map shows a fiftieth of the planet, 1/√50 of its width: a quarter of the way across is about 12.7° west of the camera.
  const box = (await minimap.boundingBox())!
  const [, lon0] = await at()
  await page.mouse.click(box.x + box.width / 4, box.y + box.height / 2)
  await expect.poll(async () => (await at())[1]! - lon0!, { timeout: SLOW }).toBeCloseTo(-12.7, 0)
  await expect(page.getByTestId('ground-readout')).toContainText('°W')
})
