import type { Page } from '@playwright/test'
import { join } from 'node:path'
import { expect, fill, inspector, setPlayhead, shot, state, stubSaveDialog, test } from './helpers'

const laws = async (page: Page) => (await state(page, 'timeline')).laws

test('eras and factions have laws, in force for a time, that reach the people under them', async ({ h }) => {
  test.slow()
  const { app, page, dir } = h
  await stubSaveDialog(app, join(dir, 'Calder (sample).universe'))
  await page.getByRole('button', { name: 'Explore a sample universe' }).click()
  await expect(page.locator('.tree-row.selected')).toHaveText(/Calder/)

  // The kingdom's laws, on its page: the timber tax was ended by the peace, long before the present day (1450).
  await page.keyboard.press('7')
  await page.getByRole('list', { name: 'The world’s factions' }).getByRole('button', { name: /The Kingdom of Varn/ }).click()
  const faction = page.getByRole('region', { name: 'Faction' })
  const kingdomLaws = faction.getByRole('group', { name: 'Laws' })
  await expect(kingdomLaws).toContainText('The king’s peace on the roads')
  await expect(kingdomLaws.locator('li', { hasText: 'The timber tax' })).toContainText('repealed')
  await expect(kingdomLaws.locator('li', { hasText: 'The timber tax' })).toHaveClass(/absent/)

  // A new one, opened in the inspector with its name ready; enacted by an event, its date follows.
  await kingdomLaws.getByRole('button', { name: '⚖ Add a law' }).click()
  const law = inspector(page).getByRole('region', { name: 'Law' })
  await expect(law.getByLabel('Law name')).toBeFocused()
  await law.getByLabel('Law name').fill('The bridge toll')
  await law.getByLabel('Law name').press('Enter')
  await law.getByLabel('Kind of law').selectOption({ label: 'Trade and coin' })
  await fill(page, 'What it says', 'A copper a cart at Kingsbridge.')
  await fill(page, 'Penalty', 'The cart')
  await expect(law).toContainText('A law of The Kingdom of Varn')
  await law.getByLabel('Enacted by').selectOption({ label: '993 · Battle of Kingsbridge' })
  await expect.poll(async () => (await laws(page)).find((l) => l.name === 'The bridge toll')).toMatchObject({ kind: 'trade', summary: 'A copper a cart at Kingsbridge.', penalty: 'The cart' })
  await expect(law.getByTestId('law-status')).toHaveText('In force at 1450; it holds from 993 on.')
  await setPlayhead(page, '900')
  await expect(law.getByTestId('law-status')).toHaveText('Not yet in force at 900; it holds from 993 on.')
  await expect(kingdomLaws.locator('li', { hasText: 'The bridge toll' })).toContainText('not yet')
  await shot(page, '88-faction-laws')

  // The clans' war-chief lives under the oak right while she's one of them; the Long Winter's law reaches everyone while it lasts.
  await setPlayhead(page, '1000')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Map/ }).first().click()
  await page.locator('.region-row', { hasText: 'Maelis Thorn' }).click()
  const over = inspector(page).getByRole('group', { name: 'Laws over them' })
  await expect(over).toContainText('The oak right')
  await expect(over).toContainText('The Greywood clans')
  await expect(over).not.toContainText('The hearth law')
  await over.getByRole('button', { name: 'The oak right' }).click()
  await expect(law.getByLabel('Law name')).toHaveValue('The oak right')

  // An era's laws, from its panel; one enacted before the era begins is flagged.
  await page.getByRole('button', { name: '+ Era' }).click()
  await fill(page, 'Era name', 'The Age of Tolls')
  // The end first: a start past the new era's end would be held to it.
  await fill(page, 'Era end', '1400')
  await fill(page, 'Era start', '1300')
  const era = inspector(page).getByRole('region', { name: 'Era' })
  await era.getByRole('button', { name: '⚖ Add a law' }).click()
  await law.getByLabel('Law name').fill('Toll on every road')
  await law.getByLabel('Law name').press('Enter')
  await expect(law).toContainText('A law of the era The Age of Tolls')
  await expect(law.getByTestId('law-status')).toHaveText('Not yet in force at 1000; it holds from 1300 until 1400.')
  await fill(page, 'Law enacted', '1250')
  await expect.poll(async () => (await laws(page)).find((l) => l.name === 'Toll on every road')?.start).not.toBeNull()
  await shot(page, '89-era-law')
  await page.getByRole('button', { name: /⚠ Warnings/ }).click()
  await expect(page.getByText('Toll on every road is enacted before the era The Age of Tolls begins')).toBeVisible()

  // Undone, it holds from the era's start again.
  await page.getByRole('button', { name: '↶ Undo' }).click()
  await expect.poll(async () => (await laws(page)).find((l) => l.name === 'Toll on every road')?.start).toBeNull()
})
