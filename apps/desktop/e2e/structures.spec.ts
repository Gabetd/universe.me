import { clickAt, expect, fill, inspector, newWorld, openGlobe, openMap, setPlayhead, shot, state, test, wheel } from './helpers'

test('place structures, weather them, and let events damage and destroy them', async ({ h }) => {
  test.slow()
  const { page } = h
  await newWorld(h, 'Kingdoms')
  await openMap(page)

  // Place a castle and a house in the year 1000.
  await setPlayhead(page, '1000')
  await page.getByRole('button', { name: 'Place structure' }).click()
  await page.getByLabel('Blueprint to place').selectOption({ label: 'Stone castle' })
  await clickAt(page, 'map', [0.5, 0.45])
  await page.getByLabel('Blueprint to place').selectOption({ label: 'House' })
  await clickAt(page, 'map', [0.505, 0.46])
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await state(page, 'timeline')).structures.map((s) => s.name)).toEqual(['Stone castle', 'House'])
  await expect(inspector(page).getByTestId('condition')).toHaveText('100 · Pristine')

  // The house is abandoned in 1100; by 1180 it has weathered, and by 1400 its thatch and timber are gone, leaving the stone chimney.
  await setPlayhead(page, '1100')
  await inspector(page).getByLabel(/Maintained from/).uncheck()
  await setPlayhead(page, '1180')
  await expect(inspector(page).getByTestId('condition')).not.toHaveText(/Pristine/)
  await expect(inspector(page).getByText(/erodes away around/)).toBeVisible()
  await setPlayhead(page, '1400')
  await expect(inspector(page).getByTestId('condition')).toHaveText(/Remnant/)
  await expect(inspector(page).getByLabel('Materials')).toContainText('Thatch')
  await expect(inspector(page).getByLabel('Condition over time')).toBeVisible()
  // A siege in 1250 at the castle damages everything within 100 km, less with distance.
  await setPlayhead(page, '1250')
  await page.getByRole('button', { name: '+ Event' }).click()
  await fill(page, 'Event title', 'The Siege')
  await inspector(page).getByRole('button', { name: '📍 Pick on map' }).click()
  await clickAt(page, 'map', [0.5, 0.45])
  await inspector(page).getByRole('button', { name: '+ Effect' }).click()
  await inspector(page).getByLabel('Effect', { exact: true }).selectOption('damage')
  await inspector(page).getByLabel('Reaches', { exact: true }).selectOption('radius')
  await fill(page, 'Radius (km)', '400')
  await expect(inspector(page).getByText(/Reaches 2 structures/)).toBeVisible()
  await shot(page, '40-effect-preview')

  await page.locator('.region-row', { hasText: 'Stone castle' }).click()
  await expect(inspector(page).getByTestId('condition')).toHaveText(/^60 · Weathered/)
  await expect(inspector(page).getByText('The Siege')).toBeVisible()

  // Later the castle is destroyed outright; it's gone at the playhead.
  await setPlayhead(page, '1400')
  await page.getByRole('button', { name: '+ Event' }).click()
  await fill(page, 'Event title', 'The Fall')
  await inspector(page).getByRole('button', { name: '+ Effect' }).click()
  await inspector(page).getByLabel('Effect', { exact: true }).selectOption('destroy')
  await inspector(page).getByLabel('Structures').getByLabel('Stone castle').check()
  await page.locator('.region-row', { hasText: 'Stone castle' }).click()
  await expect(inspector(page).getByTestId('condition')).toHaveText('Gone')
  await openGlobe(page)
  await setPlayhead(page, '1260')
  await shot(page, '41-structures-globe')
  // Up close.
  await wheel(page, page.getByTestId('globe'), -400, 12)
  await shot(page, '42-structures-close', { wait: 800 })

  // Weathering's own milestones are on the timeline; one click makes the ruin a real event, placed at the house.
  await wheel(page, page.locator('.tl-ruler'), 500, 3)
  const ruin = page.getByLabel('Weathering').getByRole('button', { name: /House falls into ruin/ })
  await expect(ruin).toBeAttached()
  await shot(page, '43-weathering')
  await ruin.click()
  await expect(inspector(page).getByLabel('Event title')).toHaveValue('House falls into ruin')
})
