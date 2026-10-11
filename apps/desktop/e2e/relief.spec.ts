import { dragPoints, expect, newWorld, openGlobe, test } from './helpers'

test('the relief slider moves when dragged, even after a drag across its corner (the view’s controls are not text to select and drag off)', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Relief')
  await openGlobe(page)
  const options = page.locator('.tool-options')
  const relief = options.getByRole('slider', { name: /^Relief/ })
  await expect(relief).toHaveValue('25')

  // Across the corner, from its value back over its name, as if selecting it.
  const value = (await options.locator('.toolbar-value').boundingBox())!
  const corner = (await options.boundingBox())!
  await dragPoints(page, { x: value.x + value.width - 2, y: value.y + value.height / 2 }, { x: corner.x + 2, y: corner.y + 2 }, { steps: 5 })
  expect(await page.evaluate(() => String(getSelection()))).toBe('')

  await page.evaluate(() => {
    window.dragged = false
    document.addEventListener('dragstart', () => (window.dragged = true), { capture: true, once: true })
  })
  const box = (await relief.boundingBox())!
  await dragPoints(page, { x: box.x + 5, y: box.y + box.height / 2 }, { x: box.x + box.width * 0.7, y: box.y + box.height / 2 }, { steps: 5 })
  expect(Number(await relief.inputValue())).toBeGreaterThan(40)
  expect(await page.evaluate(() => window.dragged)).toBe(false)
})

declare global {
  interface Window {
    dragged: boolean
  }
}
