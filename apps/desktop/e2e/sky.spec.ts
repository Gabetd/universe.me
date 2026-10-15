import type { Page } from '@playwright/test'
import { addChild, expect, fill, inspector, newWorld, orbitOf, playhead, row, setPlayhead, shot, test, wheel } from './helpers'

/**
 * Where the system view points at something along the line through its star (a pointer cursor):
 * the middle of each stretch of it, left and right of the star, in px from the view's corner.
 */
const orbitCrossings = (page: Page) =>
  page.getByTestId('viewport').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect()
    // The star is drawn 10 px below the middle.
    const [cx, y] = [rect.width / 2, rect.height / 2 + 10]
    const runs: number[][] = []
    let run: number[] | null = null
    for (let x = 0; x < rect.width; x += 1) {
      canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: rect.left + x, clientY: rect.top + y, bubbles: true }))
      if (canvas.style.cursor === 'pointer') (run ??= []).push(x)
      else if (run) {
        runs.push(run)
        run = null
      }
    }
    canvas.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    const middles = runs.map((r) => r[r.length >> 1]!)
    return { y, left: middles.filter((x) => x < cx), right: middles.filter((x) => x > cx) }
  })

test('star systems: real orbits at the playhead, an editable star and orbits, derived calendars', async ({ h }) => {
  test.slow()
  const { page } = h
  await newWorld(h, 'Skies', { planet: 'Mercury', surface: false })
  await row(page, 'Sol').click()
  await addChild(page, '+ Planet', 'Terra')
  await addChild(page, '+ Moon', 'Luna')
  await row(page, 'Terra').click()
  await addChild(page, '+ Surface', 'Terra')
  await row(page, 'Sol').click()
  await addChild(page, '+ Planet', 'Jove')

  // The system: a Sun-like star, its habitable zone, planets on their orbits.
  await row(page, 'Sol').click()
  await expect(inspector(page).getByLabel('Star')).toContainText('5,772 K')
  await page.getByRole('button', { name: '▶ 1 month/s' }).click()
  await shot(page, '80-star-system', { wait: 1500 })
  // However close their orbits bring them on screen, no planet is drawn over another or over the sun.
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-overlaps', '0')
  await page.getByRole('button', { name: 'Pause' }).click()

  // Pointing at a planet, or anywhere on its orbit's line, outlines it and shows its card: its level, its name and how it goes round.
  const crossings = await orbitCrossings(page)
  const card = page.locator('.cosmos-card')
  const box = (await page.getByTestId('viewport').boundingBox())!
  const named = async (xs: number[]) => {
    const texts: string[] = []
    for (const x of xs) {
      await page.mouse.move(box.x + x, box.y + crossings.y)
      await expect(card).toBeVisible()
      texts.push(await card.innerText())
    }
    return texts
  }
  // Each orbit crosses the line through the star on both sides, and the planet is on one at most.
  for (const side of [crossings.left, crossings.right]) expect(await named(side)).toContainEqual(expect.stringMatching(/^Planet\nTerra\n[\d.]+ AU/i))
  await page.mouse.move(box.x + 2, box.y + 2)
  await expect(card).toHaveCount(0)

  // Terra's orbit: made up until changed; a 30-hour day changes its calendar.
  await orbitOf(page, 'Terra')

  // Resting the pointer on a value says what it changes, after a second (not at once).
  const hint = page.getByRole('tooltip')
  await inspector(page).locator('label', { has: page.getByText('Inclination (°)', { exact: true }) }).hover()
  await page.waitForTimeout(500)
  await expect(hint).toHaveCount(0)
  await expect(hint).toContainText('eclipses are rarer')
  await shot(page, '84-value-hint')
  await page.mouse.move(2, 2)
  await expect(hint).toHaveCount(0)
  await expect(inspector(page).getByLabel('Orbit', { exact: true })).toContainText('Made up from the seed')
  await expect(inspector(page).getByLabel('Worked out from the orbit')).toContainText('365 days in 12 months')
  await fill(page, 'Day (hours)', '30')
  await expect(inspector(page).getByLabel('Orbit', { exact: true })).not.toContainText('Made up from the seed')
  await expect(inspector(page).getByLabel('Worked out from the orbit')).toContainText('days in')
  await expect(page.getByTestId('sky-readout')).toContainText('Luna:')
  await shot(page, '81-planet-moons')
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-overlaps', '0')

  // The timeline has a track of the moon's phases and the eclipses; an eclipse becomes an event with a click.
  await row(page, 'Terra').click()
  await expect(page.getByLabel('Moons and eclipses')).toContainText('Zoom in')
  // About two and a half years: room for the phases, and always a few eclipses.
  await wheel(page, page.locator('.tl-ruler'), -500, 5)
  await expect(page.locator('.tl-moon.full-moon').first()).toBeAttached()
  await expect(page.locator('.tl-eclipse').first()).toBeAttached()
  await shot(page, '82-moon-track')
  const eclipse = page.locator('.tl-eclipse').first()
  const name = (await eclipse.getAttribute('aria-label'))!.split(',')[0]!
  await eclipse.click()
  await expect(inspector(page).getByLabel('Event title')).toHaveValue(new RegExp(name.split(' ').slice(0, 2).join(' ')))

  // The world's calendar follows: its months can be renamed, and dates are written with them.
  await row(page, 'Terra').click()
  const calendar = inspector(page).getByLabel('Calendar', { exact: true })
  await expect(calendar).toContainText('days of 30.')
  await fill(page, 'Month 1 name', 'Frostmoon')
  await setPlayhead(page, '3 Frostmoon 120')
  // Zoomed in to days, it's written back with the new month name.
  await expect(playhead(page)).toHaveValue('3 Frostmoon 120')

  // Farther from the star the world is colder: more ice and tundra.
  await expect(inspector(page).getByLabel('Climate', { exact: true })).toContainText('against Earth')
  await row(page, 'Terra').click()
  await fill(page, 'Distance (AU)', '1.25')
  await row(page, 'Terra').click()
  await expect(inspector(page).getByLabel('Climate', { exact: true })).toContainText('−')
  await shot(page, '83-colder-world', { wait: 1500 })
  await page.getByRole('button', { name: /Undo/ }).click()

  // Undoing the rename, the eclipse event and the orbit goes back to the Earth calendar.
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: /Undo/ }).click()
  await expect(calendar).toContainText('The Earth calendar')
})
