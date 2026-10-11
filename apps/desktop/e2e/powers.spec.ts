import type { Page } from '@playwright/test'
import { expect, fill, inspector, newWorld, row, setPlayhead, shot, state, test, wheel } from './helpers'

const powers = (page: Page) => page.getByRole('region', { name: 'Power system' })

/** Adds an era on the timeline: an age, as the Powers page sees it. */
async function addEra(page: Page, name: string, start: string, end: string): Promise<void> {
  await page.getByRole('button', { name: '+ Era' }).click()
  await fill(page, 'Era name', name)
  // The end first: a start after the new era's end would be turned down.
  await fill(page, 'Era end', end)
  await fill(page, 'Era start', start)
}

test('power systems: one from a template, what holds in every age, what changes in each, and how strong it is', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Aerth')
  await page.getByRole('button', { name: '✨ Powers' }).click()

  // Started from a template, with its questions.
  await page.getByRole('region', { name: 'Start a power system' }).getByRole('button', { name: /^Magic/ }).click()
  const name = powers(page).getByLabel('Power system name')
  await expect(name).toHaveValue('Magic')
  await name.fill('The Weave')
  await name.press('Enter')
  await expect(page.getByRole('list', { name: 'Power systems' })).toContainText('The Weave')
  const source = powers(page).getByLabel('Source', { exact: true })
  await source.fill('Starlight, caught in silver')
  await source.blur()
  await expect.poll(async () => (await state(page, 'timeline')).powers[0]?.values).toEqual({ source: 'Starlight, caught in silver' })

  // The world's eras are its ages; the one at the playhead is marked.
  await addEra(page, 'Age of Wonders', '0', '500')
  await addEra(page, 'Age of Silence', '500', '1000')
  await setPlayhead(page, '600')
  const ages = powers(page).getByRole('tablist', { name: 'Ages' })
  await expect(ages.getByRole('tab')).toHaveText([/^Always/, /^Age of Wonders\s*0 – 500/, /^Age of Silence\s*now\s*500 – 1000/])

  // In one age: what's different then (the rest as always), and how strong it is.
  await ages.getByRole('tab', { name: /Age of Wonders/ }).click()
  await expect(powers(page).getByLabel('Source', { exact: true })).toHaveAttribute('placeholder', 'As always: Starlight, caught in silver')
  const rules = powers(page).getByLabel('Rules', { exact: true })
  await rules.fill('Anyone who can sing may weave')
  await rules.blur()
  await powers(page).getByRole('button', { name: 'Say how strong it is in Age of Wonders' }).click()
  const strength = powers(page).getByLabel('Strength in Age of Wonders', { exact: true })
  await strength.fill('90')
  await strength.blur()
  await expect
    .poll(async () => (await state(page, 'timeline')).powerAges.map((a) => ({ values: a.values, strength: a.strength })))
    .toEqual([{ values: { rules: 'Anyone who can sing may weave' }, strength: 0.9 }])
  // Scrolled back up as you would (the page keeps still for anything else).
  await expect(async () => {
    await wheel(page, page.locator('.powers-scroll'), -600, 3)
    await expect(ages).toBeInViewport({ timeout: 1000 })
  }).toPass()
  await shot(page, '150-powers')

  // A question of its own, from Always.
  await ages.getByRole('tab', { name: /^Always/ }).click()
  await powers(page).getByText('Questions it answers').click()
  await powers(page).getByLabel('New question').fill('What it costs the world')
  await powers(page).getByRole('button', { name: 'Add', exact: true }).click()
  await expect(powers(page).getByLabel('What it costs the world', { exact: true })).toBeVisible()

  // Deleted from its right-click menu with its ages, and back with one undo.
  await page.getByRole('list', { name: 'Power systems' }).getByRole('button', { name: /The Weave/ }).click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveAccessibleName('Power system · The Weave')
  await page.getByRole('menu').getByRole('menuitem', { name: 'Delete The Weave' }).click()
  await expect(page.getByRole('region', { name: 'Start a power system' })).toBeVisible()
  await expect.poll(async () => (await state(page, 'timeline')).powerAges.length).toBe(0)
  await page.getByRole('button', { name: '↶ Undo' }).click()
  await expect(powers(page).getByLabel('Power system name')).toHaveValue('The Weave')
  await expect.poll(async () => (await state(page, 'timeline')).powerAges.length).toBe(1)
})

test('power systems are the universe’s: pinned to a star system, one holds on everything in it, and any place lists those that hold there', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Shared')
  await page.getByRole('button', { name: '✨ Powers' }).click()
  await page.getByRole('region', { name: 'Start a power system' }).getByRole('button', { name: /^Divine/ }).click()
  const pinned = powers(page).getByRole('list', { name: 'Pinned to' })
  await expect(pinned).toContainText('Terra Surface')

  // Pinned to the star system as well, from the system itself.
  const pinTo = powers(page).getByLabel('Pin to')
  await pinTo.selectOption((await pinTo.locator('option', { hasText: 'Sol' }).getAttribute('value'))!)
  await expect(pinned).toContainText('Sol')
  const sol = (await state(page, 'nodes')).find((n) => n.name === 'Sol')!.id
  await expect.poll(async () => (await state(page, 'timeline')).powers[0]?.pins).toContain(sol)

  // The planet, in the star system, has it; and the star system says it's pinned there.
  await row(page, 'Terra').click()
  const here = inspector(page).getByRole('region', { name: 'Power systems here' })
  await expect(here).toContainText('Divine powers')
  await row(page, 'Sol').click()
  await expect(here).toContainText('pinned here')
  await here.scrollIntoViewIfNeeded()
  await shot(page, '151-powers-shared')
  await here.getByRole('button', { name: 'Unpin Divine powers from Sol' }).click()
  await expect.poll(async () => (await state(page, 'timeline')).powers[0]?.pins).not.toContain(sol)
  await expect(here).toContainText('None hold here yet')
  // Pinned here again from the universe's library.
  await here.getByLabel('Pin a power system here').selectOption({ label: 'Divine powers' })
  await expect(here).toContainText('pinned here')
})
