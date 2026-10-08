import type { Page } from '@playwright/test'
import { center, clickAt, closeProject, dragPoints, drawRegion, expect, fill, inspector, newWorld, openGlobe, openMap, row, setPlayhead, settledBox, shot, state, test } from './helpers'

const timeline = (page: Page) => state(page, 'timeline')
const eventBar = (page: Page, title: string) => page.locator('.tl-event', { hasText: title })

test('build a history: events, dates, links, groups, eras and warnings', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Chronicle', { planet: 'Aerth', surface: false })

  // An event at the playhead, then given a title and a date.
  await page.getByRole('button', { name: '+ Event' }).click()
  await expect(inspector(page).getByRole('region', { name: 'Event' })).toBeVisible()
  await fill(page, 'Event title', 'Founding of Aster')
  await fill(page, 'Starts', '1204')
  await page.getByRole('button', { name: '+ Event' }).click()
  await fill(page, 'Event title', 'The Long War')
  await fill(page, 'Starts', '1250')
  await fill(page, 'Ends', '1280')
  await page.getByRole('button', { name: 'Fit' }).click()
  await expect(eventBar(page, 'Founding of Aster')).toBeVisible()
  await expect(eventBar(page, 'The Long War')).toBeVisible()
  expect((await timeline(page)).events.map((e) => [e.title, e.precision, e.end !== null])).toEqual([
    ['Founding of Aster', 'year', false],
    ['The Long War', 'year', true]
  ])

  // Drag from one event's connector onto the other to link them.
  await eventBar(page, 'Founding of Aster').hover()
  const from = await settledBox(eventBar(page, 'Founding of Aster').locator('.tl-connector'))
  const to = (await eventBar(page, 'The Long War').boundingBox())!
  await dragPoints(page, center(from), { x: to.x + 20, y: to.y + to.height / 2 }, { steps: 6 })
  await expect.poll(async () => (await timeline(page)).links.length).toBe(1)
  await expect(page.locator('.tl-link')).toHaveCount(1)

  // Drag a span to move it in time (one undo step), and the wheel zooms the ruler.
  const startOf = async (title: string) => (await timeline(page)).events.find((e) => e.title === title)!.start
  const before = await startOf('The Long War')
  const bar = (await eventBar(page, 'The Long War').boundingBox())!
  await dragPoints(page, center(bar), { x: center(bar).x + 80, y: center(bar).y }, { steps: 5 })
  await expect.poll(() => startOf('The Long War')).toBeGreaterThan(before)
  await page.getByRole('button', { name: '↶ Undo' }).click()
  await expect.poll(() => startOf('The Long War')).toBe(before)
  const firstTick = () => page.locator('.tl-tick').first().textContent()
  const tickBefore = await firstTick()
  await page.mouse.move(bar.x + bar.width / 2, bar.y + 40)
  await page.mouse.wheel(0, 600)
  await expect.poll(firstTick).not.toBe(tickBefore)
  await page.getByRole('button', { name: 'Fit' }).click()

  // A third event, added by double-clicking the track, made to come before its cause.
  const track = (await page.getByTestId('timeline-track').boundingBox())!
  await page.mouse.dblclick(track.x + track.width * 0.9, track.y + 10)
  await fill(page, 'Event title', 'Refugees arrive')
  await eventBar(page, 'The Long War').click()
  await inspector(page).getByLabel('Link to event').selectOption({ label: 'Refugees arrive' })
  await expect.poll(async () => (await timeline(page)).links.length).toBe(2)
  await eventBar(page, 'Refugees arrive').click()
  await fill(page, 'Starts', '1100')
  await expect(page.getByRole('button', { name: '⚠ 1' })).toBeVisible()
  await page.getByRole('button', { name: '⚠ 1' }).click()
  await expect(page.getByText('“Refugees arrive” starts before “The Long War”, which causes it')).toBeVisible()

  // Group two events, collapse the group, then undo the grouping.
  await eventBar(page, 'Founding of Aster').click()
  await eventBar(page, 'The Long War').click({ modifiers: ['Shift'] })
  await page.getByRole('toolbar', { name: 'Timeline' }).getByRole('button', { name: 'Group' }).click()
  await expect(page.locator('.tl-group')).toHaveCount(1)
  await page.getByRole('button', { name: 'Collapse New group' }).click()
  await expect(eventBar(page, 'The Long War')).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand New group' }).click()
  await expect(eventBar(page, 'The Long War')).toHaveCount(1)

  // An era behind it all.
  await page.getByRole('button', { name: '+ Era' }).click()
  await fill(page, 'Era name', 'Age of Kings')
  await fill(page, 'Era start', '1150')
  await fill(page, 'Era end', '1300')
  await expect(page.locator('.tl-era-chip', { hasText: 'Age of Kings' })).toBeVisible()

  // A lane, and an event moved into it with the inspector.
  await page.getByRole('button', { name: '+ Lane' }).click()
  await page.getByRole('button', { name: 'Fit' }).click()
  await eventBar(page, 'Refugees arrive').click()
  await inspector(page).getByLabel('Lane').selectOption({ label: 'New lane' })
  await expect.poll(async () => (await timeline(page)).events.find((e) => e.title === 'Refugees arrive')?.laneId).not.toBeNull()

  await shot(page, '20-timeline')

  // Delete an event with the keyboard; its link goes too, and both come back with undo.
  await eventBar(page, 'Refugees arrive').click()
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await timeline(page)).links.length).toBe(1)
  await page.getByRole('button', { name: '↶ Undo' }).click()
  await expect.poll(async () => (await timeline(page)).links.length).toBe(2)

  // The planet keeps its own history; the star system has a separate (empty) one.
  await row(page, 'Sol').click()
  await expect(page.locator('.tl-event')).toHaveCount(0)
  await row(page, 'Aerth').click()
  await expect(page.locator('.tl-event')).toHaveCount(3)
})

test('place events on the world and watch regions come and go with the playhead', async ({ h }) => {
  const { app, page } = h
  await newWorld(h, 'Atlas')
  await openMap(page)

  // A region, founded in 1200 by an event.
  await drawRegion(page)
  await fill(page, 'Region name', 'Aster')
  await page.getByRole('button', { name: 'Navigate' }).click()

  await page.getByRole('button', { name: '+ Event' }).click()
  await fill(page, 'Event title', 'Founding of Aster')
  await fill(page, 'Starts', '1200')
  await inspector(page).getByLabel('Add region').selectOption({ label: 'Aster' })
  // Pick a point on the map for it too.
  await inspector(page).getByRole('button', { name: '📍 Pick on map' }).click()
  await clickAt(page, 'map', [0.26, 0.35])
  await expect.poll(async () => (await timeline(page)).events[0]?.locations.map((l) => l.kind)).toEqual(['region', 'point'])
  await expect(inspector(page).getByText(/📍 -?\d/)).toBeVisible()

  await page.locator('.region-row', { hasText: 'Aster' }).click()
  await fill(page, 'Founded', '1200')
  await inspector(page).getByLabel('Caused by').selectOption({ label: 'Founding of Aster' })
  await expect.poll(async () => (await timeline(page)).changes.map((c) => [c.change, c.causeEventId !== null])).toEqual([['appear', true]])

  // At the playhead's starting point (year 0) Aster doesn't exist yet; in 1250 it does.
  await expect(page.locator('.region-row.absent', { hasText: 'Aster' })).toHaveCount(1)
  await setPlayhead(page, '1250')
  await expect(page.locator('.region-row.absent')).toHaveCount(0)

  // Renamed in 1300: the name the map shows follows the playhead.
  await setPlayhead(page, '1300')
  await inspector(page).getByLabel('New name at playhead').fill('Greater Aster')
  await inspector(page).getByRole('button', { name: 'Rename then' }).click()
  await expect.poll(async () => (await timeline(page)).changes.length).toBe(2)

  // Selecting the event highlights where it happened, and its pin, on the map.
  await page.getByRole('button', { name: 'Fit' }).click()
  await eventBar(page, 'Founding of Aster').click()
  await shot(page, '21-world-at-time', { wait: 400 })
  await openGlobe(page)
  await shot(page, '22-globe-at-time')

  // The history survives a reopen.
  await closeProject(app)
  await page.getByRole('button', { name: /Atlas/ }).click()
  await row(page, 'Terra Surface').click()
  const t = await timeline(page)
  expect(t.events).toHaveLength(1)
  expect(t.changes.map((c) => c.change).sort()).toEqual(['appear', 'update'])
})
