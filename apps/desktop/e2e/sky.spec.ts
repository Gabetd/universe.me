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

  // The timeline has a track of the moon's phases and the eclipses; an eclipse becomes an event with a click.
  await row(page, 'Terra Surface').click()
  await expect(page.getByLabel('Moons and eclipses')).toContainText('Zoom in')
  const ruler = (await page.locator('.tl-ruler').boundingBox())!
  await page.mouse.move(ruler.x + ruler.width / 2, ruler.y + ruler.height / 2)
  // About two and a half years: room for the phases, and always a few eclipses.
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -500)
  await expect(page.locator('.tl-moon.full-moon').first()).toBeAttached()
  await expect(page.locator('.tl-eclipse').first()).toBeAttached()
  await page.screenshot({ path: 'test-results/82-moon-track.png' })
  const eclipse = page.locator('.tl-eclipse').first()
  const name = (await eclipse.getAttribute('aria-label'))!.split(',')[0]!
  await eclipse.click()
  await expect(inspector(page).getByLabel('Event title')).toHaveValue(new RegExp(name.split(' ').slice(0, 2).join(' ')))

  // The world's calendar follows: its months can be renamed, and dates are written with them.
  await row(page, 'Terra Surface').click()
  const calendar = inspector(page).getByLabel('Calendar', { exact: true })
  await expect(calendar).toContainText('days of 30.')
  const first = calendar.getByLabel('Month 1 name')
  await first.fill('Frostmoon')
  await first.press('Enter')
  const playhead = page.getByRole('toolbar', { name: 'Timeline' }).getByLabel('Playhead')
  await playhead.fill('3 Frostmoon 120')
  await playhead.press('Enter')
  // Zoomed in to days, it's written back with the new month name.
  await expect(playhead).toHaveValue('3 Frostmoon 120')

  // Farther from the star the world is colder: more ice and tundra.
  await expect(inspector(page).getByLabel('Climate', { exact: true })).toContainText('against Earth')
  await row(page, 'Terra').click()
  const distance = inspector(page).getByLabel('Distance (AU)')
  await distance.fill('1.25')
  await distance.press('Enter')
  await row(page, 'Terra Surface').click()
  await expect(inspector(page).getByLabel('Climate', { exact: true })).toContainText('−')
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'test-results/83-colder-world.png' })
  await page.getByRole('button', { name: /Undo/ }).click()

  // Undoing the rename, the eclipse event and the orbit goes back to the Earth calendar.
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: /Undo/ }).click()
  await expect(calendar).toContainText('The Earth calendar')
})
