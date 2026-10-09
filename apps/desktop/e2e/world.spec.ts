import type { Page } from '@playwright/test'
import { closeProject, drag, drawRegion, expect, fill, inspector, newWorld, openGlobe, row, shot, SLOW, test, viewReady, writeNotes } from './helpers'

const worldState = (page: Page) =>
  page.evaluate(async () => {
    const s = await window.universe.getState()
    const world = s.worlds[0]!
    return { revision: world.terrainRevision, seaLevel: world.settings.seaLevel, regions: s.regions.map((r) => r.name) }
  })

/** Notes the pointer events from here on, to say what a drag that changed nothing met (it did on Windows 11 alone). */
const notePointers = (page: Page) =>
  page.evaluate(() => {
    const seen: string[] = ((window as unknown as { pointersSeen: string[] }).pointersSeen = [])
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture'])
      window.addEventListener(
        type,
        (e) => {
          const p = e as PointerEvent
          const t = p.target as HTMLElement
          if (seen.length < 20) seen.push(`${type} ${p.pointerType} b${p.button} at ${p.clientX},${p.clientY} on ${t.tagName}.${t.className}`)
        },
        true
      )
  })

/** What the page looked like to a drag at `[x, y]` of the globe, for the failure's message. */
const pointerReport = (page: Page, [x, y]: [number, number]) =>
  page.evaluate(({ fx, fy }) => {
    const globe = document.querySelector<HTMLElement>('[data-testid="globe"]')!
    const box = globe.getBoundingClientRect()
    const canvas = globe.querySelector('canvas')
    const at = document.elementFromPoint(box.x + box.width * fx, box.y + box.height * fy) as HTMLElement | null
    return JSON.stringify({
      window: [innerWidth, innerHeight, devicePixelRatio, screen.width, screen.height],
      globe: [box.x, box.y, box.width, box.height],
      canvas: canvas && [canvas.clientWidth, canvas.clientHeight, canvas.width, canvas.height],
      toolbar: document.querySelector('.world-toolbar')?.getBoundingClientRect().height,
      under: at && `${at.tagName}.${at.className}`,
      fonts: document.fonts.status,
      pressed: Array.from(document.querySelectorAll('.world-toolbar [aria-pressed="true"]')).map((b) => b.getAttribute('title') ?? b.textContent),
      events: (window as unknown as { pointersSeen: string[] }).pointersSeen
    })
  }, { fx: x, fy: y })

test('edit a world: sculpt, paint, undo, draw a region, and keep it after reopening', async ({ h }) => {
  test.slow()
  const { app, page } = h
  await newWorld(h, 'Terra', { cluster: 'Local Group' })

  // The globe renders once terrain generation finishes in the worker.
  await expect(page.getByTestId('globe')).toBeVisible({ timeout: SLOW })
  await viewReady(page)
  await shot(page, '10-globe', { wait: 800 })

  // Sculpt on the globe (drawn, so the drag lands on it).
  await page.getByRole('button', { name: 'Raise' }).click()
  await notePointers(page)
  await drag(page, 'globe', [0.45, 0.45], [0.55, 0.5])
  const report = await pointerReport(page, [0.45, 0.45]).catch(String)
  await expect.poll(async () => (await worldState(page)).revision, { message: `the stroke changed nothing: ${report}` }).toBe(1)

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
