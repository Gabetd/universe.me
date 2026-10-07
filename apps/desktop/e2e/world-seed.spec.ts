import { expect, test, type Page } from '@playwright/test'
import { addChild, inspector, launch, newProject, row, type AppHandle } from './helpers'

let h: AppHandle
test.beforeEach(async () => {
  h = await launch()
})
test.afterEach(async () => {
  await h?.close()
})

/** A world's node seed and generation settings, by world name. */
const world = (page: Page, name: string) =>
  page.evaluate(async (n) => {
    const s = await window.universe.getState()
    const node = s.nodes.find((x) => x.name === n)!
    const { settings } = s.worlds.find((w) => w.id === node.id)!
    return { seed: node.seed, settings }
  }, name)

async function setSeed(page: Page, seed: string) {
  const input = inspector(page).getByLabel('Seed', { exact: true })
  await input.fill(seed)
  await input.press('Enter')
}

test('a seed decides the whole world and locks its options; a world code recreates it exactly', async () => {
  const { page } = h
  await newProject(h, 'Seeds')
  await addChild(page, '+ Galaxy Cluster', 'Virgo')
  await addChild(page, '+ Galaxy', 'Milky Way')
  await addChild(page, '+ Star System', 'Sol')
  await addChild(page, '+ Planet', 'First')
  await addChild(page, '+ World surface', 'First Surface')
  await expect(page.getByTestId('globe')).toBeVisible({ timeout: 20_000 })

  // A custom world: options are editable.
  const water = inspector(page).getByLabel('Water', { exact: true })
  await expect(water).toBeEnabled()

  // Typing a seed generates the world from it and locks the options.
  await setSeed(page, 'Avalon')
  await expect(inspector(page).getByText('Generated from')).toBeVisible()
  await expect(water).toBeDisabled()
  const seeded = await world(page, 'First Surface')
  expect(seeded.settings.seedText).toBe('Avalon')
  const code = (await page.getByTestId('world-code').textContent())!
  expect(code).toMatch(/^W1-/)
  await expect(page.getByText('Generating terrain…')).toHaveCount(0, { timeout: 20_000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'test-results/30-seeded-world.png' })

  // The same seed on another planet grows the same world.
  await row(page, 'Sol').click()
  await addChild(page, '+ Planet', 'Second')
  await addChild(page, '+ World surface', 'Second Surface')
  await setSeed(page, code)
  await expect.poll(async () => (await world(page, 'Second Surface')).seed).toBe(seeded.seed)
  expect((await world(page, 'Second Surface')).settings).toEqual({ ...seeded.settings, seedText: code })
  await expect(page.getByTestId('world-code')).toHaveText(code)

  // Customize unlocks the options, starting from the seeded world; changing one changes the code.
  await inspector(page).getByRole('button', { name: 'Customize' }).click()
  await expect(water).toBeEnabled()
  await water.focus()
  for (let i = 0; i < 5; i++) await water.press('ArrowRight')
  await page.locator('.panel-title').click()
  await expect.poll(async () => (await world(page, 'Second Surface')).settings.terrain.water).toBeCloseTo(seeded.settings.terrain.water + 0.05, 5)
  await expect(page.getByTestId('world-code')).not.toHaveText(code)

  // Presets and colors are custom options too.
  await inspector(page).getByLabel('Start from preset').selectOption('Ice world')
  await expect.poll(async () => (await world(page, 'Second Surface')).settings.terrain.temperature).toBe(-26)
  await inspector(page).getByLabel('Vegetation').fill('#7a3fa0')
  await expect.poll(async () => (await world(page, 'Second Surface')).settings.terrain.vegetationColor).toBe('#7a3fa0')
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'test-results/31-custom-world.png' })
})
