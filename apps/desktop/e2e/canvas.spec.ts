import type { Page } from '@playwright/test'
import { center, clickAt, dragPoints, expect, fill, inspector, newWorld, openMap, playhead, setPlayhead, settledBox, shot, state, test } from './helpers'

const node = (page: Page, title: string) => page.locator('.event-node', { hasText: title })

async function addEvent(page: Page, title: string, starts: string, ends?: string) {
  await page.getByRole('button', { name: '+ Event' }).click()
  await fill(page, 'Event title', title)
  await fill(page, 'Starts', starts)
  if (ends) await fill(page, 'Ends', ends)
}

test('events become nodes on the world canvas: move, hide, link, recede with time, and jump to them', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Canvas')
  await openMap(page)

  await addEvent(page, 'Founding', '1200')
  await addEvent(page, 'War of the Straits', '1250', '1260')
  await inspector(page).getByRole('button', { name: '📍 Pick on map' }).click()
  await clickAt(page, 'map', [0.7, 0.6])
  await expect.poll(async () => (await state(page, 'timeline')).events.find((e) => e.title === 'War of the Straits')?.locations.length).toBe(1)
  await addEvent(page, 'Treaty', '1300')

  // Every event is on the canvas, without being put there.
  await page.getByRole('button', { name: '🗂 Canvas' }).click()
  await expect(page.locator('.event-node')).toHaveCount(3)

  // Move a node; the spot is saved.
  const before = (await node(page, 'Treaty').boundingBox())!
  await dragPoints(page, { x: before.x + 40, y: before.y + 20 }, { x: before.x + 60, y: before.y + 120 })
  await expect.poll(async () => (await state(page, 'timeline')).events.find((e) => e.title === 'Treaty')?.canvas).toBeTruthy()

  // Link two nodes by dragging from one's handle onto the other (after fitting them all in view, for small screens).
  await page.getByRole('toolbar', { name: 'Canvas' }).getByRole('button', { name: 'Fit' }).click()
  // The nodes glide into place.
  const target = await settledBox(node(page, 'Treaty'))
  const handle = await settledBox(node(page, 'War of the Straits').getByTitle('Drag onto another node to link them'))
  await dragPoints(page, center(handle), center(target))
  await expect.poll(async () => (await state(page, 'timeline')).links.length).toBe(1)
  await expect(page.locator('.canvas-link')).toHaveCount(1)

  // Hide one; it can be brought back.
  await page.getByRole('button', { name: 'Hide Founding' }).click()
  await expect(page.locator('.event-node')).toHaveCount(2)
  await page.getByRole('button', { name: 'Show hidden (1)' }).click()
  await expect(node(page, 'Founding')).toHaveClass(/hidden-node/)
  await page.getByRole('button', { name: 'Hide hidden nodes' }).click()

  // As time passes, finished events recede but stay clickable.
  await setPlayhead(page, '1255')
  const during = (await settledBox(node(page, 'War of the Straits'))).width
  await shot(page, '30-canvas-1255')
  await setPlayhead(page, '1340')
  await expect.poll(async () => (await node(page, 'War of the Straits').boundingBox())!.width).toBeLessThan(during * 0.8)
  await shot(page, '31-canvas-1340')

  // Clicking a node goes to when and where it happened.
  await node(page, 'War of the Straits').click()
  await expect(page.getByTestId('map')).toBeVisible()
  await expect(playhead(page)).toHaveValue('1250')
  await expect(inspector(page).getByLabel('Event title', { exact: true })).toHaveValue('War of the Straits')
  await shot(page, '32-canvas-jump', { wait: 300 })
})
