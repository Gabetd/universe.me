import type { Locator, Page } from '@playwright/test'
import { expect, newProject, SLOW, state, test, wheel } from './helpers'

/** Turns the wheel over `target` three notches at a time, each zoom between levels played out first, until `done` passes. */
async function wheelUntil(page: Page, target: Locator, dy: number, done: () => Promise<void>) {
  await expect(async () => {
    await expect(page.locator('.zoom-arrive')).toHaveCount(0)
    await wheel(page, target, dy, 3)
    await done()
  }).toPass({ timeout: SLOW })
}

const level = (page: Page, name: string) => () => expect(page.locator('.viewport-overlay.top')).toContainText(name, { timeout: 1000 })
const shown = (target: Locator) => () => expect(target).toBeVisible({ timeout: 1000 })

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
