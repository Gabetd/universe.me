import type { Locator, Page } from '@playwright/test'
import { expect, newProject, SLOW, state, test, wheel } from './helpers'

/**
 * Turns the wheel over `target` three notches at a time, each zoom between levels played out first, until `done` passes.
 * Each try looks first whether it's there already: a level can take longer to show than one look waits (the globe, drawn
 * in software), and by then what was wheeled over is gone, so wheeling again can't be what comes first.
 */
async function wheelUntil(page: Page, target: Locator, dy: number, done: (timeout?: number) => Promise<void>) {
  await expect(async () => {
    await expect(page.locator('.zoom-arrive')).toHaveCount(0)
    if (await done(100).then(() => true, () => false)) return
    await wheel(page, target, dy, 3)
    await done()
  }).toPass({ timeout: SLOW })
}

const level = (page: Page, name: string) => (timeout = 1000) => expect(page.locator('.viewport-overlay.top')).toContainText(name, { timeout })
const shown = (target: Locator) => (timeout = 1000) => expect(target).toBeVisible({ timeout })

test('the wheel alone goes from the universe down to the ground and back up, claiming what it goes into on the way', async ({ h }) => {
  // Every level, each drawn in software on CI machines.
  test.slow()
  const { page } = h
  await newProject(h, 'All the way down')
  const view = page.getByTestId('viewport')
  const globe = page.locator('[data-testid="globe"] canvas')
  const ground = page.locator('[data-testid="ground"] canvas')

  for (const name of ['Galaxy Cluster view', 'Galaxy view', 'Star System view', 'Planet view']) await wheelUntil(page, view, -400, level(page, name))
  await wheelUntil(page, view, -400, shown(globe))
  await wheelUntil(page, globe, -400, shown(ground))
  expect((await state(page, 'nodes')).map((n) => n.kind)).toEqual(['universe', 'galaxy_cluster', 'galaxy', 'star_system', 'body', 'world'])

  await wheelUntil(page, ground, 400, shown(globe))
  await wheelUntil(page, globe, 400, level(page, 'Planet view'))
  for (const name of ['Star System view', 'Galaxy view', 'Galaxy Cluster view', 'Universe view']) await wheelUntil(page, view, 400, level(page, name))
})
