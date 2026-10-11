import type { Locator, Page } from '@playwright/test'
import { expect, inspector, menu, newWorld, shot, test, writeNotes } from './helpers'

/** Right-clicks a field over its first word. */
async function rightClickWord(field: Locator): Promise<void> {
  const box = (await field.boundingBox())!
  await field.click({ button: 'right', position: { x: 14, y: box.height / 2 } })
}

const spellingMenu = (page: Page) => page.getByRole('menu')

test('spelling: right-click a misspelled word for corrections, add words to the dictionary, and the universe’s names are words already', async ({ h }) => {
  const { app, page } = h
  await newWorld(h, 'Spelling', { planet: 'Qoroth' })
  await page.getByRole('button', { name: '+ Event' }).click()
  const title = inspector(page).getByLabel('Event title')

  // A word typed wrong: its corrections, and one picked replaces it.
  await title.fill('Seige')
  await rightClickWord(title)
  await expect(spellingMenu(page)).toHaveAccessibleName('Spelling · Seige')
  await expect(spellingMenu(page).getByRole('menuitem', { name: 'Siege', exact: true })).toBeVisible()
  await expect(spellingMenu(page).getByRole('menuitem', { name: 'Paste' })).toBeVisible()
  await shot(page, '230-spelling', { views: false })
  await spellingMenu(page).getByRole('menuitem', { name: 'Siege', exact: true }).click()
  await expect(title).toHaveValue('Siege')

  // In the notes editor too.
  await writeNotes(page, 'Event notes', 'Wals of stone')
  const notes = inspector(page).getByRole('textbox', { name: 'Event notes', exact: true })
  await rightClickWord(notes.locator('p').first())
  await spellingMenu(page).getByRole('menuitem', { name: 'Walls', exact: true }).click()
  await expect(notes).toHaveText('Walls of stone')

  // A word of one's own, added from the menu, isn't misspelled any more: the menu only edits.
  await title.fill('Glimmerwick')
  await rightClickWord(title)
  await spellingMenu(page).getByRole('menuitem', { name: 'Add “Glimmerwick” to the dictionary' }).click()
  await rightClickWord(title)
  await expect(spellingMenu(page).getByRole('menuitem', { name: 'Select all' })).toBeVisible()
  await expect(spellingMenu(page).getByRole('menuitem', { name: /to the dictionary/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // The universe's own names are words already.
  await title.fill('Qoroth')
  await rightClickWord(title)
  await expect(spellingMenu(page).getByRole('menuitem', { name: 'Paste' })).toBeVisible()
  await expect(spellingMenu(page).getByRole('menuitem', { name: /to the dictionary/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Edit → Dictionary lists the words added, to take out or add to.
  await menu(app, 'Edit', 'Dictionary…')
  const dictionary = page.getByRole('dialog', { name: 'Dictionary' })
  await expect(dictionary.getByRole('list', { name: 'Your words' })).toHaveText(/Glimmerwick/)
  await dictionary.getByLabel('New word').fill('Thalassor')
  await dictionary.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dictionary.getByRole('list', { name: 'Your words' })).toContainText('Thalassor')
  await dictionary.getByRole('button', { name: 'Remove Glimmerwick' }).click()
  await expect(dictionary.getByRole('list', { name: 'Your words' })).not.toContainText('Glimmerwick')
  await page.keyboard.press('Escape')
  await title.fill('Glimmerwick')
  await rightClickWord(title)
  await expect(spellingMenu(page).getByRole('menuitem', { name: 'Add “Glimmerwick” to the dictionary' })).toBeVisible()
})
