import { join } from 'node:path'
import { expect, inspector, openMap, setPlayhead, shot, state, stubSaveDialog, test } from './helpers'

test('factions: founded, part of one another, with members and land over time; people related; the graph and the map at the playhead', async ({ h }) => {
  test.slow()
  const { app, page, dir } = h
  await stubSaveDialog(app, join(dir, 'Calder (sample).universe'))
  await page.getByRole('button', { name: 'Explore a sample universe' }).click()
  await expect(page.locator('.tree-row.selected')).toHaveText(/Calder Surface/)

  // The Factions page (7): the sample's factions, a house under its kingdom.
  await page.keyboard.press('7')
  const list = page.getByRole('list', { name: 'The world’s factions' })
  await expect(list).toContainText('The Kingdom of Varn')
  await list.getByRole('button', { name: /House Aldric/ }).click()
  const faction = page.getByRole('region', { name: 'Faction' })
  await expect(faction.getByLabel('Part of')).toHaveValue((await state(page, 'timeline')).factions.find((f) => f.name === 'The Kingdom of Varn')!.id)
  await expect(faction.getByRole('list', { name: 'Members' })).toContainText('Aldric of Varn')
  // In 1450 the house is gone (the castle was given up in 1215); in 430 it's there, with its king.
  await expect(faction.getByTestId('faction-status')).toHaveText(/Gone by 1450/)
  await setPlayhead(page, '430')
  await expect(faction.getByTestId('faction-status')).toHaveText(/There at 430/)

  // A new faction, with a member from the playhead and an enemy.
  await page.getByLabel('New faction').selectOption({ label: 'Order' })
  await expect(faction.getByLabel('Faction name')).toHaveValue('New order')
  await faction.getByLabel('Faction name').fill('The Silver Hand')
  await faction.getByLabel('Faction name').press('Enter')
  await faction.getByLabel('Add a member').selectOption({ label: 'Edda of Varn' })
  await expect(faction.getByRole('list', { name: 'Members' })).toContainText('Edda of Varn')
  await faction.getByLabel('Relate to').selectOption({ label: '🌲 The Greywood clans' })
  await faction.getByLabel('As').selectOption({ label: 'Enemy' })
  await faction.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(faction.getByRole('list', { name: 'Stands with' })).toContainText('The Greywood clans')
  const silver = (await state(page, 'timeline')).factions.find((f) => f.name === 'The Silver Hand')!
  expect((await state(page, 'timeline')).memberships.filter((m) => m.factionId === silver.id)).toHaveLength(1)

  // The graph at the playhead: Aldric, his daughter and the new order.
  await page.getByRole('tab', { name: /Who’s related/ }).click()
  const graph = page.getByTestId('relationship-graph')
  await expect(graph.getByRole('button', { name: 'The Silver Hand' })).toBeVisible()
  await expect(graph.getByRole('button', { name: 'Edda of Varn' })).toBeVisible()
  await shot(page, '220-relationships', { views: false })

  // A character's panel has their factions and relationships.
  await graph.getByRole('button', { name: 'Edda of Varn' }).click()
  await expect(inspector(page).getByRole('list', { name: 'Factions' })).toContainText('The Silver Hand')
  await expect(inspector(page).getByRole('list', { name: 'Relationships' })).toContainText('Aldric of Varn')
  await expect(inspector(page).getByRole('list', { name: 'Relationships' })).toContainText('Parent')

  // On the map, the regions coloured by who holds them: the kingdom, then the Spine too once silver is struck there.
  await openMap(page)
  await page.getByRole('button', { name: /Territory/ }).click()
  const legend = page.getByRole('complementary', { name: 'Territory' })
  await expect(legend).toContainText('The Kingdom of Varn')
  await expect(legend).toContainText('The Greywood clans')
  await setPlayhead(page, '1000')
  await shot(page, '221-territory')

  // Deleting the faction takes its membership and enmity with it, and undo brings them back.
  await page.keyboard.press('7')
  await list.getByRole('button', { name: /The Silver Hand/ }).click()
  await faction.getByRole('button', { name: 'Delete faction' }).click()
  await expect(list).not.toContainText('The Silver Hand')
  expect((await state(page, 'timeline')).memberships.some((m) => m.factionId === silver.id)).toBe(false)
  await page.getByRole('button', { name: '↶ Undo' }).click()
  await expect(list).toContainText('The Silver Hand')
  expect((await state(page, 'timeline')).relationships.some((r) => r.from.id === silver.id || r.to.id === silver.id)).toBe(true)
})
