import { expect, test, type Page } from '@playwright/test'
import { addChild, closeProject, drag, inspector, launch, newProject, row, SLOW, writeNotes, type AppHandle } from './helpers'

let h: AppHandle
test.beforeEach(async () => {
  h = await launch()
})
test.afterEach(async () => {
  await h?.close()
})

const worldState = (page: Page) =>
  page.evaluate(async () => {
    const s = await window.universe.getState()
    const world = s.worlds[0]!
    return { revision: world.terrainRevision, seaLevel: world.settings.seaLevel, regions: s.regions.map((r) => r.name) }
  })

test('edit a world: sculpt, paint, undo, draw a region, and keep it after reopening', async () => {
  const { app, page } = h
  await newProject(h, 'Terra')
  await addChild(page, '+ Galaxy Cluster', 'Local Group')
  await addChild(page, '+ Galaxy', 'Milky Way')
  await addChild(page, '+ Star System', 'Sol')
  await addChild(page, '+ Planet', 'Terra')
  await addChild(page, '+ World surface', 'Terra Surface')

  // The globe renders once terrain generation finishes in the worker.
  await expect(page.getByTestId('globe')).toBeVisible({ timeout: SLOW })
  await expect(page.getByText('Generating terrain…')).toHaveCount(0)
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'test-results/10-globe.png' })

  // Sculpt on the globe.
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
  await page.getByRole('button', { name: 'Draw region' }).click()
  const map = (await page.getByTestId('map').boundingBox())!
  for (const [x, y] of [[0.2, 0.3], [0.3, 0.28], [0.32, 0.4], [0.22, 0.42]] as const) {
    await page.mouse.click(map.x + map.width * x, map.y + map.height * y)
  }
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await worldState(page)).regions).toEqual(['New Region'])

  // The new region is selected: rename it and write notes.
  const name = inspector(page).getByLabel('Region name')
  await name.fill('The Dry Reaches')
  await name.press('Enter')
  await writeNotes(page, 'Region notes', 'Nomads cross here in winter.')
  await expect.poll(async () => (await worldState(page)).regions).toEqual(['The Dry Reaches'])

  // Sea level from the inspector.
  const sea = inspector(page).getByLabel('Sea level')
  await sea.focus()
  for (let i = 0; i < 6; i++) await sea.press('ArrowRight')
  await page.locator('.panel-title').click()
  await expect.poll(async () => (await worldState(page)).seaLevel).toBe(300)
  await page.getByRole('button', { name: 'Navigate' }).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'test-results/11-map.png' })

  await page.getByRole('button', { name: '🌐 Globe' }).click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'test-results/12-globe-edited.png' })

  // Reopen: region, notes and terrain edits are all in the file.
  await closeProject(app)
  await page.getByRole('button', { name: /Terra/ }).click()
  await row(page, 'Terra Surface').click()
  await page.locator('.region-row', { hasText: 'The Dry Reaches' }).click()
  await expect(page.getByRole('textbox', { name: 'Region notes' })).toHaveText('Nomads cross here in winter.')
  expect(await worldState(page)).toMatchObject({ revision: 4, seaLevel: 300 })
})
