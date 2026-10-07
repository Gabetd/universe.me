import { expect, test, type Page } from '@playwright/test'
import { addChild, inspector, launch, newProject, type AppHandle } from './helpers'

let h: AppHandle
test.beforeEach(async () => {
  h = await launch()
})
test.afterEach(async () => {
  await h?.close()
})

const timeline = (page: Page) => page.evaluate(async () => (await window.universe.getState()).timeline)
const node = (page: Page, title: string) => page.locator('.event-node', { hasText: title })

async function fill(page: Page, label: string, value: string) {
  const input = inspector(page).getByLabel(label, { exact: true })
  await input.fill(value)
  await input.press('Enter')
}

async function addEvent(page: Page, title: string, starts: string, ends?: string) {
  await page.getByRole('button', { name: '+ Event' }).click()
  await fill(page, 'Event title', title)
  await fill(page, 'Starts', starts)
  if (ends) await fill(page, 'Ends', ends)
}

const width = async (page: Page, title: string) => (await node(page, title).boundingBox())!.width

test('events become nodes on the world canvas: move, hide, link, recede with time, and jump to them', async () => {
  const { page } = h
  await newProject(h, 'Canvas')
  await addChild(page, '+ Galaxy Cluster', 'Virgo')
  await addChild(page, '+ Galaxy', 'Milky Way')
  await addChild(page, '+ Star System', 'Sol')
  await addChild(page, '+ Planet', 'Terra')
  await addChild(page, '+ World surface', 'Terra Surface')
  await page.getByRole('button', { name: '🗺 Map' }).click()
  await expect(page.getByText('Generating terrain…')).toHaveCount(0, { timeout: 20_000 })

  await addEvent(page, 'Founding', '1200')
  await addEvent(page, 'War of the Straits', '1250', '1260')
  const map = (await page.getByTestId('map').boundingBox())!
  await inspector(page).getByRole('button', { name: '📍 Pick on map' }).click()
  await page.mouse.click(map.x + map.width * 0.7, map.y + map.height * 0.6)
  await expect.poll(async () => (await timeline(page)).events.find((e) => e.title === 'War of the Straits')?.locations.length).toBe(1)
  await addEvent(page, 'Treaty', '1300')

  // Every event is on the canvas, without being put there.
  await page.getByRole('button', { name: '🗂 Canvas' }).click()
  await expect(page.locator('.event-node')).toHaveCount(3)

  // Move a node; the spot is saved.
  const before = (await node(page, 'Treaty').boundingBox())!
  await page.mouse.move(before.x + 40, before.y + 20)
  await page.mouse.down()
  await page.mouse.move(before.x + 60, before.y + 120, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await timeline(page)).events.find((e) => e.title === 'Treaty')?.canvas).toBeTruthy()

  // Link two nodes by dragging from one's handle onto the other (after fitting them all in view, for small screens).
  await page.getByRole('toolbar', { name: 'Canvas' }).getByRole('button', { name: 'Fit' }).click()
  await page.waitForTimeout(400) // nodes glide into place
  const target = (await node(page, 'Treaty').boundingBox())!
  const handle = (await node(page, 'War of the Straits').getByTitle('Drag onto another node to link them').boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await timeline(page)).links.length).toBe(1)
  await expect(page.locator('.canvas-link')).toHaveCount(1)

  // Hide one; it can be brought back.
  await page.getByRole('button', { name: 'Hide Founding' }).click()
  await expect(page.locator('.event-node')).toHaveCount(2)
  await page.getByRole('button', { name: 'Show hidden (1)' }).click()
  await expect(node(page, 'Founding')).toHaveClass(/hidden-node/)
  await page.getByRole('button', { name: 'Hide hidden nodes' }).click()

  // As time passes, finished events recede but stay clickable.
  const playhead = page.getByRole('toolbar', { name: 'Timeline' }).getByLabel('Playhead')
  await playhead.fill('1255')
  await playhead.press('Enter')
  await page.waitForTimeout(400)
  const during = await width(page, 'War of the Straits')
  await page.screenshot({ path: 'test-results/30-canvas-1255.png' })
  await playhead.fill('1340')
  await playhead.press('Enter')
  await page.waitForTimeout(400)
  expect(await width(page, 'War of the Straits')).toBeLessThan(during * 0.8)
  await page.screenshot({ path: 'test-results/31-canvas-1340.png' })

  // Clicking a node goes to when and where it happened.
  await node(page, 'War of the Straits').click()
  await expect(page.getByTestId('map')).toBeVisible()
  await expect(playhead).toHaveValue('1250')
  await expect(inspector(page).getByLabel('Event title', { exact: true })).toHaveValue('War of the Straits')
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/32-canvas-jump.png' })
})
