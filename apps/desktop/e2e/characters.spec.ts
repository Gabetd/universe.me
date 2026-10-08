import type { Page } from '@playwright/test'
import { clickAt, expect, fill, inspector, newWorld, openMap, setPlayhead, SLOW, state, test } from './helpers'

const characters = async (page: Page) => (await state(page, 'timeline')).characters

test('characters live, travel from place to place, and go to events', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Sagas')
  await openMap(page)

  // Born in 1000, wherever we click.
  await setPlayhead(page, '1000')
  await inspector(page).getByRole('button', { name: '+ Character' }).click()
  await clickAt(page, 'map', [0.4, 0.4])
  await expect.poll(async () => (await characters(page))[0]?.stops.length).toBe(1)
  await fill(page, 'Character name', 'Aria')
  await fill(page, 'Died', '1062')
  await expect(inspector(page).getByTestId('character-status')).toHaveText(/^Aged 0 at 1000, at /)

  // In 1030 she walks east, arriving then.
  await setPlayhead(page, '1030')
  await inspector(page).getByRole('button', { name: '🧭 Send to…' }).click()
  await clickAt(page, 'map', [0.45, 0.4])
  await expect.poll(async () => (await characters(page))[0]?.stops.length).toBe(2)
  const [stop1, stop2] = (await characters(page))[0]!.stops
  expect(stop2!.lon).toBeGreaterThan(stop1!.lon)
  expect(stop2!.travel).toBeGreaterThan(20 * 86400)
  await expect(inspector(page).getByLabel('Journey')).toContainText('on the road')

  // An event somewhere else; sending her there makes a stop at its start.
  await setPlayhead(page, '1040')
  await page.getByRole('button', { name: '+ Event' }).click()
  await fill(page, 'Event title', 'The Council')
  await inspector(page).getByRole('button', { name: /Pick on map/ }).click()
  await clickAt(page, 'map', [0.42, 0.45])
  await page.locator('.region-row', { hasText: 'Aria' }).click()
  await inspector(page).getByLabel('Go to an event').selectOption({ label: '1040 · The Council' })
  await expect.poll(async () => (await characters(page))[0]?.stops.length).toBe(3)
  await expect(inspector(page).getByLabel('Journey')).toContainText('for The Council')
  await page.screenshot({ path: 'test-results/70-character-map.png' })

  // Before she's born, and after she dies, she's nowhere.
  await setPlayhead(page, '990')
  await expect(inspector(page).getByTestId('character-status')).toHaveText(/Not born yet/)
  await setPlayhead(page, '1070')
  await expect(inspector(page).getByTestId('character-status')).toHaveText('Died aged 62.')
  await expect(inspector(page).getByRole('button', { name: '🧭 Send to…' })).toBeDisabled()

  // Up close she's life-size, on the ground.
  await setPlayhead(page, '1050')
  await inspector(page).getByRole('button', { name: '🔍 View up close' }).click()
  await expect(page.locator('[data-chunks="25"]')).toBeVisible({ timeout: SLOW })
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'test-results/71-character-ground.png' })

  // Delete removes her; undo brings her back.
  await page.locator('.region-row', { hasText: 'Aria' }).click()
  await inspector(page).getByRole('button', { name: 'Delete character' }).click()
  await expect.poll(async () => (await characters(page)).length).toBe(0)
  await page.getByRole('button', { name: /Undo/ }).click()
  await expect.poll(async () => (await characters(page)).length).toBe(1)
})
