import { expect, newWorld, shot, SLOW, state, test } from './helpers'

test('species: suggested from the world’s biomes, a food web, links and warnings', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Fauna')
  await page.getByRole('button', { name: '🦌 Species' }).click()
  await expect(page.getByText(/Biomes here:/)).toBeVisible({ timeout: SLOW })

  // Suggestions for the biomes it has, already linked into a food web.
  await page.getByRole('button', { name: 'Suggest for this world' }).click()
  await expect.poll(async () => (await state(page, 'timeline')).lifeforms.length).toBeGreaterThan(5)
  const { lifeforms, ecolinks } = await state(page, 'timeline')
  expect(ecolinks.length).toBeGreaterThan(3)
  expect(lifeforms.some((s) => s.diet === 'producer')).toBe(true)
  await shot(page, '90-food-web')

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
  await shot(page, '91-species-editor')

  // Deleting it takes its links; undo brings both back.
  await page.getByRole('button', { name: 'Delete species' }).click()
  await expect.poll(async () => (await state(page, 'timeline')).lifeforms.some((s) => s.name === 'Dragon')).toBe(false)
  await page.getByRole('button', { name: /Undo/ }).click()
  await expect.poll(async () => (await state(page, 'timeline')).ecolinks.length).toBe(ecolinks.length + 1)
})
