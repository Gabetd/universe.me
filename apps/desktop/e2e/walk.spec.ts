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

  await page.getByRole('radio', { name: 'Fly' }).click()
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
