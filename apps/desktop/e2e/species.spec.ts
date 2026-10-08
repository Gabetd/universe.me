import { expect, test, type Page } from '@playwright/test'
import { addChild, launch, newProject, type AppHandle } from './helpers'

let h: AppHandle
test.beforeEach(async () => {
  h = await launch()
})
test.afterEach(async () => {
  await h?.close()
})

const species = (page: Page) => page.evaluate(async () => (await window.universe.getState()).timeline)

test('species: suggested from the world’s biomes, a food web, links and warnings', async () => {
  const { page } = h
  await newProject(h, 'Fauna')
  await addChild(page, '+ Galaxy Cluster', 'Virgo')
  await addChild(page, '+ Galaxy', 'Milky Way')
  await addChild(page, '+ Star System', 'Sol')
  await addChild(page, '+ Planet', 'Terra')
  await addChild(page, '+ World surface', 'Terra Surface')
  await page.getByRole('button', { name: '🦌 Species' }).click()
  await expect(page.getByText(/Biomes here:/)).toBeVisible({ timeout: 20_000 })

  // Suggestions for the biomes it has, already linked into a food web.
  await page.getByRole('button', { name: 'Suggest for this world' }).click()
  await expect.poll(async () => (await species(page)).lifeforms.length).toBeGreaterThan(5)
  const { lifeforms, ecolinks } = await species(page)
  expect(ecolinks.length).toBeGreaterThan(3)
  expect(lifeforms.some((s) => s.diet === 'producer')).toBe(true)
  await page.screenshot({ path: 'test-results/90-food-web.png' })

  // A new predator with nothing to eat gets a warning, until it eats something.
  await page.getByRole('button', { name: '+ Species' }).click()
  const name = page.getByLabel('Species name', { exact: true })
  await name.fill('Dragon')
  await name.press('Enter')
  await page.getByLabel('Diet').selectOption('carnivore')
  await expect(page.getByLabel('Food web warnings')).toContainText('Dragon eats nothing')
  const prey = lifeforms.find((s) => s.kind === 'fauna')!
  await page.getByLabel('Link to').selectOption({ label: prey.name })
  await expect(page.getByText('Dragon eats nothing')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Dragon' })).toBeVisible()
  await page.screenshot({ path: 'test-results/91-species-editor.png' })

  // Deleting it takes its links; undo brings both back.
  await page.getByRole('button', { name: 'Delete species' }).click()
  await expect.poll(async () => (await species(page)).lifeforms.some((s) => s.name === 'Dragon')).toBe(false)
  await page.getByRole('button', { name: /Undo/ }).click()
  await expect.poll(async () => (await species(page)).ecolinks.length).toBe(ecolinks.length + 1)
})
