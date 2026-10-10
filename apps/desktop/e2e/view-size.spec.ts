import { expect, newWorld, openGlobe, openMap, test } from './helpers'

/**
 * A view that opens while the zoom between levels is still scaling it in
 * fills its box once the zoom is over: the globe used to keep the size it
 * measured mid-zoom (half its box, say) until the window was resized.
 */
test('the globe fills its box when it opens mid-zoom', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Sizes')
  await openMap(page)
  // The zoom's arriving view, held at half size, as it is partway in.
  await page.evaluate(() => document.querySelector<HTMLElement>('.zoom-view')!.style.setProperty('transform', 'scale(0.5)'))
  await openGlobe(page)
  await page.evaluate(() => document.querySelector<HTMLElement>('.zoom-view')!.style.removeProperty('transform'))
  const fills = async () => {
    const [canvas, box] = [await page.locator('.globe-wrap canvas').boundingBox(), await page.locator('.globe-wrap').boundingBox()]
    return !!canvas && !!box && Math.abs(canvas.width - box.width) < 2 && Math.abs(canvas.height - box.height) < 2
  }
  await expect.poll(fills).toBe(true)
})
