import { join } from 'node:path'
import { expect, inspector, newWorld, openMap, setPlayhead, shot, state, stubSaveDialog, test } from './helpers'

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
  // A lane of her own on the timeline: her life, and the event she's in.
  await inspector(page).getByLabel('A lane of its own on the timeline').check()
  const lane = page.getByLabel('Edda of Varn’s lane')
  await expect(lane.getByRole('button', { name: /Edda of Varn, 424/ })).toBeVisible()
  const coronation = (await state(page, 'timeline')).events.find((e) => e.title === 'Aldric crowned first king of Varn')!
  await page.locator('.tl-event', { hasText: 'Aldric crowned first king of Varn' }).click()
  await inspector(page).getByLabel('Add who took part').selectOption({ label: 'Edda of Varn' })
  await expect(inspector(page).getByRole('list', { name: 'Who took part' })).toContainText('Edda of Varn')
  expect((await state(page, 'timeline')).events.find((e) => e.id === coronation.id)!.participants).toEqual([{ kind: 'character', id: expect.any(String) }])
  await expect(lane.getByRole('button', { name: /Aldric crowned first king of Varn, in Edda/ })).toBeVisible()
  await page.locator('.tl-life-bar').first().click()

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

test('sub-factions, as deep as they go: a kingdom’s house, the house’s branch and its own part; a part moves up when what held it goes', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Houses')
  await page.keyboard.press('7')
  const faction = page.getByRole('region', { name: 'Faction' })
  const name = async (to: string) => {
    await faction.getByLabel('Faction name').fill(to)
    await faction.getByLabel('Faction name').press('Enter')
  }
  const idOf = async (n: string) => (await state(page, 'timeline')).factions.find((f) => f.name === n)!.id
  await page.getByLabel('New faction').selectOption({ label: 'Kingdom' })
  await name('Varn')

  // From a faction's page, a part of it; and from that, a part of its own.
  await faction.getByLabel('New sub-faction').selectOption({ label: 'House' })
  await expect(faction.getByLabel('Faction name')).toHaveValue('New house')
  await expect(faction.getByLabel('Part of')).toHaveValue(await idOf('Varn'))
  await name('House Aldric')
  await faction.getByLabel('New sub-faction').selectOption({ label: 'Band' })
  await name('The Aldrics of Tarn')
  await expect(faction.getByLabel('Part of')).toHaveValue(await idOf('House Aldric'))

  // Or from its right-click menu: a fourth level.
  const list = page.getByRole('list', { name: 'The world’s factions' })
  await list.getByRole('button', { name: /The Aldrics of Tarn/ }).click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Add a sub-faction' }).click()
  await expect(faction.getByLabel('Faction name')).toHaveValue('New sub-faction')
  await expect(faction.getByLabel('Part of')).toHaveValue(await idOf('The Aldrics of Tarn'))

  // The list nests them, each under what it's part of; each page lists its parts.
  const indent = (n: string | RegExp) => list.getByRole('listitem').filter({ hasText: n }).evaluate((li) => (li as HTMLElement).style.paddingLeft || '0px')
  expect([await indent(/^.*Varn/), await indent('House Aldric'), await indent('The Aldrics of Tarn'), await indent('New sub-faction')]).toEqual(['0px', '14px', '28px', '42px'])
  await list.getByRole('button', { name: /House Aldric/ }).click()
  await expect(faction.getByRole('group', { name: 'Sub-factions' })).toContainText('The Aldrics of Tarn')
  await shot(page, '75-sub-factions')

  // Gone, the house hands its branch up to the kingdom.
  await faction.getByRole('button', { name: 'Delete faction' }).click()
  await list.getByRole('button', { name: /The Aldrics of Tarn/ }).click()
  await expect(faction.getByLabel('Part of')).toHaveValue(await idOf('Varn'))
})
