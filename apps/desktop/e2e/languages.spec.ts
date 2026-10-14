import { expect, inspector, newWorld, openMap, row, shot, SLOW, state, test } from './helpers'

test('languages: a world speaks one, and its rivers, lakes and new factions are named by its rules; a star system’s new planets in its own', async ({ h }) => {
  test.slow()
  const { page } = h
  await newWorld(h, 'Tongues')

  // On the world: a new language from the Desert preset, spoken here at once, and its panel open.
  const language = inspector(page).getByRole('region', { name: 'Language' })
  await language.getByLabel('Start a language from').first().selectOption('Desert')
  await language.getByRole('button', { name: 'New language spoken here' }).first().click()
  const panel = inspector(page).getByRole('region', { name: 'Language' }).first()
  await expect(panel.getByLabel('Language name')).toHaveValue('Desert')
  await expect(panel.getByLabel('Rivers named')).toContainText('Wadi ')
  await shot(page, '170-language')

  // Its rivers are named by its rule, in the list and in their panels.
  await openMap(page)
  const rivers = inspector(page).getByRole('region', { name: 'Rivers and lakes' }).getByRole('group', { name: 'Rivers' }).locator('.region-row')
  await expect(rivers.first()).toBeVisible({ timeout: SLOW })
  await expect(rivers.first()).toContainText(/^Wadi \S+/)

  // Its rule changed, the rivers follow.
  await panel.getByLabel('Rivers', { exact: true }).fill('Oued {name}')
  await panel.getByLabel('Rivers', { exact: true }).press('Enter')
  await expect(rivers.first()).toContainText(/^Oued \S+/)

  // A new faction there is named in it.
  await page.keyboard.press('7')
  await page.getByLabel('New faction').selectOption({ label: 'Kingdom' })
  await expect(page.getByRole('region', { name: 'Faction' }).getByLabel('Faction name')).toHaveValue(/^Banu \S+$/)

  // A star system speaking Elvish: a planet added there is named in it, not "New Planet".
  await row(page, 'Sol').click()
  const sol = inspector(page).getByRole('region', { name: 'Language' })
  await sol.getByLabel('Start a language from').selectOption('Elvish')
  await sol.getByRole('button', { name: 'New language spoken here' }).click()
  await inspector(page).getByRole('button', { name: '+ Planet', exact: true }).click()
  const nodes = await state(page, 'nodes')
  const planets = nodes.filter((n) => n.kind === 'body')
  expect(planets.map((p) => p.name)).toContain('Terra')
  expect(planets.some((p) => p.name !== 'Terra' && !p.name.startsWith('New'))).toBe(true)
})
