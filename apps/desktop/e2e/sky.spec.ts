import { expect, test } from '@playwright/test'
import { addChild, inspector, launch, newProject, row, type AppHandle } from './helpers'

let h: AppHandle
test.beforeEach(async () => {
  h = await launch()
})
test.afterEach(async () => {
  await h?.close()
})

test('star systems: real orbits at the playhead, an editable star and orbits, derived calendars', async () => {
  const { page } = h
  await newProject(h, 'Skies')
  await addChild(page, '+ Galaxy Cluster', 'Virgo')
  await addChild(page, '+ Galaxy', 'Milky Way')
  await addChild(page, '+ Star System', 'Sol')
  await addChild(page, '+ Planet', 'Mercury')
  await row(page, 'Sol').click()
  await addChild(page, '+ Planet', 'Terra')
  await addChild(page, '+ Moon', 'Luna')
  await row(page, 'Terra').click()
  await addChild(page, '+ World surface', 'Terra Surface')
  await row(page, 'Sol').click()
  await addChild(page, '+ Planet', 'Jove')

  // The system: a Sun-like star, its habitable zone, planets on their orbits.
  await row(page, 'Sol').click()
  await expect(inspector(page).getByLabel('Star')).toContainText('5,772 K')
  await page.getByRole('button', { name: '▶ 1 month/s' }).click()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: 'Pause' }).click()
  await page.screenshot({ path: 'test-results/80-star-system.png' })

  // Terra's orbit: made up until changed; a 30-hour day changes its calendar.
  await row(page, 'Terra').click()
  await expect(inspector(page).getByLabel('Orbit', { exact: true })).toContainText('Made up from the seed')
  await expect(inspector(page).getByLabel('Worked out from the orbit')).toContainText('365 days in 12 months')
  const day = inspector(page).getByLabel('Day (hours)')
  await day.fill('30')
  await day.press('Enter')
  await expect(inspector(page).getByLabel('Orbit', { exact: true })).not.toContainText('Made up from the seed')
  await expect(inspector(page).getByLabel('Worked out from the orbit')).toContainText('days in')
  await expect(page.getByTestId('sky-readout')).toContainText('Luna:')
  await page.screenshot({ path: 'test-results/81-planet-moons.png' })
  await page.getByRole('button', { name: /Undo/ }).click()
  await expect(inspector(page).getByLabel('Orbit', { exact: true })).toContainText('Made up from the seed')
})
