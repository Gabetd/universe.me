import type { Page } from '@playwright/test'
import { closeProject, drag, drawRegion, expect, fill, inspector, newWorld, openGlobe, row, shot, SLOW, test, viewReady, writeNotes } from './helpers'

const worldState = (page: Page) =>
  page.evaluate(async () => {
    const s = await window.universe.getState()
    const world = s.worlds[0]!
    return { revision: world.terrainRevision, seaLevel: world.settings.seaLevel, regions: s.regions.map((r) => r.name) }
  })

test('edit a world: sculpt, paint, undo, draw a region, and keep it after reopening', async ({ h }) => {
  const { app, page } = h
  await newWorld(h, 'Terra', { cluster: 'Local Group' })

  // The globe renders once terrain generation finishes in the worker.
  await expect(page.getByTestId('globe')).toBeVisible({ timeout: SLOW })
  await viewReady(page)
  await shot(page, '10-globe', { wait: 800 })

  // Sculpt on the globe (drawn, so the drag lands on it).
  await page.getByRole('button', { name: 'Raise' }).click()
  await drag(page, 'globe', [0.45, 0.45], [0.55, 0.5])
  await expect.poll(async () => (await worldState(page)).revision).toBe(1)

  // Switch to the map and sculpt there, then undo it.
  await page.getByRole('button', { name: '🗺 Map' }).click()
  await page.getByRole('button', { name: 'Lower' }).click()
  await drag(page, 'map', [0.3, 0.5], [0.4, 0.55])
  await expect.poll(async () => (await worldState(page)).revision).toBe(2)
  await page.getByRole('button', { name: '↶ Undo' }).click()
  await expect.poll(async () => (await worldState(page)).revision).toBe(3)

  await page.getByRole('button', { name: 'Paint biome' }).click()
  await page.getByRole('radio', { name: 'Desert' }).click()
  await drag(page, 'map', [0.6, 0.4], [0.7, 0.42])
  await expect.poll(async () => (await worldState(page)).revision).toBe(4)

  // Draw a region with four clicks and Enter.
  await drawRegion(page)
  await expect.poll(async () => (await worldState(page)).regions).toEqual(['New Region'])

  // The new region is selected: rename it and write notes.
  await fill(page, 'Region name', 'The Dry Reaches')
  await writeNotes(page, 'Region notes', 'Nomads cross here in winter.')
  await expect.poll(async () => (await worldState(page)).regions).toEqual(['The Dry Reaches'])

  // Sea level from the inspector.
  const sea = inspector(page).getByLabel('Sea level')
  await sea.focus()
  for (let i = 0; i < 6; i++) await sea.press('ArrowRight')
  await page.locator('.panel-title').click()
  await expect.poll(async () => (await worldState(page)).seaLevel).toBe(300)
  await page.getByRole('button', { name: 'Navigate' }).click()
  await shot(page, '11-map', { wait: 500 })

  await openGlobe(page)
  await shot(page, '12-globe-edited')

  // Reopen: region, notes and terrain edits are all in the file.
  await closeProject(app)
  await page.getByRole('button', { name: /Terra/ }).click()
  await row(page, 'Terra Surface').click()
  await page.locator('.region-row', { hasText: 'The Dry Reaches' }).click()
  await expect(page.getByRole('textbox', { name: 'Region notes' })).toHaveText('Nomads cross here in winter.')
  expect(await worldState(page)).toMatchObject({ revision: 4, seaLevel: 300 })
})
