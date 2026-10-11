import type { Locator, Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { center, clickAt, dragPoints, expect, fill, inspector, menu, newWorld, openMap, playhead, setPlayhead, settledBox, shot, state, stubSaveDialog, test } from './helpers'

const node = (page: Page, title: string) => page.locator('.event-node', { hasText: title })

async function addEvent(page: Page, title: string, starts: string, ends?: string) {
  await page.getByRole('button', { name: '+ Event' }).click()
  await fill(page, 'Event title', title)
  await fill(page, 'Starts', starts)
  if (ends) await fill(page, 'Ends', ends)
}

test('events become nodes on the world canvas: move, hide, link, recede with time, and go to them with a double-click', async ({ h }) => {
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
  await page.getByRole('group', { name: 'Board' }).getByRole('button', { name: 'Zoom to fit' }).click()
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

  // Double-clicking a node goes to when and where it happened.
  await node(page, 'War of the Straits').dblclick()
  await expect(page.getByTestId('map')).toBeVisible()
  await expect(playhead(page)).toHaveValue('1250')
  await expect(inspector(page).getByLabel('Event title', { exact: true })).toHaveValue('War of the Straits')
  await shot(page, '32-canvas-jump', { wait: 300 })
})

/** A 2×1 PNG, for a picture card. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGM4oaHxX0PjxH8AEPMELwjne3oAAAAASUVORK5CYII=', 'base64')

test('the canvas as Obsidian has it: cards of every kind, connections, selection, groups, colours, resizing, duplicating, the board’s tools, and a card turned into an event', async ({ h }) => {
  test.slow()
  const { app, page, dir } = h
  await newWorld(h, 'Board')
  await openMap(page)
  await addEvent(page, 'Founding', '1200')
  await page.getByRole('button', { name: '🗂 Canvas' }).click()
  const board = page.getByTestId('event-canvas')
  const cards = async () => (await state(page, 'timeline')).cards.filter((c) => !c.deletedAt)
  const card = (kind: string) => page.locator(`.canvas-card.card-${kind}`)
  /** Clicks a card where nothing else covers it (another card, a label, the bar over the selection) and not on a button or link in it. */
  const pickCard = async (kind: string | Locator, shift = false) => {
    const spot = await (typeof kind === 'string' ? card(kind) : kind).first().evaluate((node) => {
      const r = node.getBoundingClientRect()
      for (let fy = 0.2; fy < 0.95; fy += 0.15) {
        for (let fx = 0.1; fx < 0.95; fx += 0.15) {
          const [x, y] = [r.left + r.width * fx, r.top + r.height * fy]
          const hit = document.elementFromPoint(x, y)
          if (hit?.closest('[data-item-id]') === node && !hit.closest('a, button, .side-handle, .resize-handle')) return { x, y }
        }
      }
      return null
    })
    expect(spot, 'somewhere to click on the card').not.toBeNull()
    if (shift) await page.keyboard.down('Shift')
    await page.mouse.click(spot!.x, spot!.y)
    if (shift) await page.keyboard.up('Shift')
  }
  /** Drags something on the board by `dx`, `dy`, from its middle, once nothing else covers it there (hover waits for that, or says what does). */
  const dragBy = async (target: Locator, dx: number, dy: number) => {
    await target.hover()
    const from = center((await target.boundingBox())!)
    await dragPoints(page, from, { x: from.x + dx, y: from.y + dy })
  }
  /** A point on the board with nothing on it, or null. */
  const emptySpot = () =>
    board.evaluate((el) => {
      const r = el.getBoundingClientRect()
      for (let fy = 0.97; fy > 0.03; fy -= 0.04) {
        for (let fx = 0.03; fx < 0.98; fx += 0.04) {
          const [x, y] = [r.left + r.width * fx, r.top + r.height * fy]
          const hit = document.elementFromPoint(x, y)
          // The board, or the layer its lines are drawn on (not a line).
          if (hit === el || hit?.classList.contains('event-links')) return { x, y }
        }
      }
      return null
    })
  const bar = page.getByRole('toolbar', { name: 'Selection' })
  const palette = page.getByRole('group', { name: 'Add to the canvas' })
  const controls = page.getByRole('group', { name: 'Board' })
  const at = async (fx: number, fy: number) => {
    const b = (await board.boundingBox())!
    return { x: b.x + b.width * fx, y: b.y + b.height * fy }
  }

  // A text card: double-click the board and write Markdown in it.
  const spot = await at(0.2, 0.3)
  await page.mouse.dblclick(spot.x, spot.y)
  await page.getByLabel('Card text').fill('# Omens\nThe **red** comet')
  await page.getByLabel('Card text').press('Control+Enter')
  await expect(card('text').locator('h1')).toHaveText('Omens')
  await expect(card('text').locator('strong')).toHaveText('red')
  await expect.poll(async () => (await cards())[0]?.text).toBe('# Omens\nThe **red** comet')

  // An element of the project, a web page and a picture.
  await palette.getByRole('button', { name: /Element/ }).click()
  await page.getByLabel('Find an element').fill('Found')
  await page.getByRole('dialog', { name: 'Add an element' }).getByRole('button', { name: 'Founding' }).click()
  await expect(card('element')).toContainText('Founding')
  await palette.getByRole('button', { name: /Link/ }).click()
  await page.getByRole('dialog', { name: 'Add a web page' }).getByLabel('Address').fill('https://example.com/atlas')
  await page.getByRole('dialog', { name: 'Add a web page' }).getByRole('button', { name: 'Add' }).click()
  await expect(card('link')).toContainText('https://example.com/atlas')
  await page.getByLabel('Picture for the canvas').setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: PNG })
  await expect(card('image').locator('img')).toHaveCount(1)
  await expect.poll(async () => (await cards()).map((c) => c.kind).sort()).toEqual(['element', 'image', 'link', 'text'])
  await controls.getByRole('button', { name: 'Zoom to fit' }).click()

  // Connected from the text card's side onto the element card; labelled, its arrows at both ends.
  const elementBox = await settledBox(card('element'))
  // A card's handles are there once it's selected (or under the pointer).
  await pickCard('text')
  await dragPoints(page, center((await card('text').locator('.side-handle.right').boundingBox())!), center(elementBox))
  await expect.poll(async () => (await state(page, 'timeline')).connections.length).toBe(1)
  // Picked by its line (wherever the cards have put it, it may run under one).
  const line = page.locator('.canvas-connection .canvas-link-hit')
  const pick = () => line.dispatchEvent('pointerdown', { button: 0, bubbles: true })
  await pick()
  await bar.getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Connection label').fill('foretells')
  await page.getByLabel('Connection label').press('Enter')
  await expect(page.locator('.canvas-edge-label')).toHaveText('foretells')
  await pick()
  await bar.getByRole('button', { name: 'Arrows' }).click()
  await bar.getByRole('radio', { name: 'Arrows at both ends' }).click()
  await expect.poll(async () => (await state(page, 'timeline')).connections[0]).toMatchObject({ label: 'foretells', arrows: 'both', fromSide: 'right' })

  // Coloured.
  await pickCard('text')
  await bar.getByRole('button', { name: 'Colour' }).click()
  await bar.getByRole('button', { name: 'Red' }).click()
  await expect.poll(async () => (await cards()).find((c) => c.kind === 'text')?.color).toBe('1')
  // Two selected with Shift-click, lined up and put in a group; the group carries what's in it.
  await pickCard('text')
  await pickCard('link', true)
  await bar.getByRole('button', { name: 'Align' }).click()
  await bar.getByRole('button', { name: 'Align tops' }).click()
  await expect.poll(async () => new Set((await cards()).filter((c) => c.kind === 'text' || c.kind === 'link').map((c) => c.y)).size).toBe(1)
  // (Lined up, they may cover each other; back as they were to go on.)
  await menu(app, 'Edit', 'Undo')
  await pickCard('text')
  await pickCard('link', true)
  await bar.getByRole('button', { name: 'Group' }).click()
  await page.getByLabel('Group label').fill('The north')
  await page.getByLabel('Group label').press('Enter')
  await expect(page.locator('.canvas-group-label')).toHaveText('The north')
  const before = (await cards()).find((c) => c.kind === 'text')!
  // All of it in view (on a small screen the group's label can be left under the toolbar).
  await controls.getByRole('button', { name: 'Zoom to fit' }).click()
  await dragBy(page.locator('.canvas-group-label'), 60, 50)
  await expect.poll(async () => (await cards()).find((c) => c.kind === 'text')!.x).not.toBe(before.x)
  const after = (await cards()).find((c) => c.kind === 'text')!
  const group = (await cards()).find((c) => c.kind === 'group')!
  expect(after.x >= group.x && after.x + after.w <= group.x + group.w).toBe(true)
  await shot(page, '33-canvas-cards', { wait: 300 })

  // Resized, duplicated and deleted, each a step to undo.
  await controls.getByRole('button', { name: 'Zoom to fit' }).click()
  await pickCard('text')
  await dragBy(card('text').locator('.resize-handle'), 80, 40)
  await expect.poll(async () => (await cards()).find((c) => c.kind === 'text')!.w).toBeGreaterThan(260)
  await pickCard('text')
  await board.press('Control+d')
  await expect.poll(async () => (await cards()).filter((c) => c.kind === 'text').length).toBe(2)
  await board.press('Delete')
  await expect.poll(async () => (await cards()).filter((c) => c.kind === 'text').length).toBe(1)
  await menu(app, 'Edit', 'Undo')
  await expect.poll(async () => (await cards()).filter((c) => c.kind === 'text').length).toBe(2)
  await menu(app, 'Edit', 'Undo')
  await expect.poll(async () => (await cards()).filter((c) => c.kind === 'text').length).toBe(1)

  // A box dragged round everything selects it all.
  const from = await at(0.02, 0.04)
  const to = await at(0.98, 0.9)
  await dragPoints(page, from, to)
  await expect(page.locator('.canvas-item.selected')).toHaveCount(6)
  await board.press('Escape')
  await expect(page.locator('.canvas-item.selected')).toHaveCount(0)

  // Dragged from a side onto empty board: a new card there, connected, to write in.
  await pickCard('element')
  const handle = center((await card('element').locator('.side-handle.bottom').boundingBox())!)
  await dragPoints(page, handle, await at(0.05, 0.6))
  await page.getByLabel('Card text').fill('What it meant')
  await page.getByLabel('Card text').press('Control+Enter')
  await expect.poll(async () => (await state(page, 'timeline')).connections.length).toBe(2)

  // A text card turned into an event at the playhead, its connections with it.
  await setPlayhead(page, '1250')
  await pickCard(card('text').filter({ hasText: 'Omens' }))
  await bar.getByRole('button', { name: 'Turn into event' }).click()
  await expect.poll(async () => (await state(page, 'timeline')).events.map((e) => e.title).sort()).toEqual(['Founding', 'Omens'])
  const events = (await state(page, 'timeline')).events
  const omens = events.find((e) => e.title === 'Omens')!
  // At the playhead, 1250, as Founding is at 1200 (times are kept in seconds).
  expect(omens.start / events.find((e) => e.title === 'Founding')!.start).toBeCloseTo(1250 / 1200, 6)
  expect((await state(page, 'timeline')).connections.some((c) => c.fromId === omens.id)).toBe(true)
  await expect(node(page, 'Omens')).toBeVisible()

  // The board's tools: 100%, zoom in, read-only, and export as an image.
  await controls.getByRole('button', { name: 'Zoom to 100%' }).click()
  await expect(controls.getByRole('button', { name: 'Zoom to 100%' })).toHaveText('100%')
  await controls.getByRole('button', { name: 'Zoom in' }).click()
  await expect(controls.getByRole('button', { name: 'Zoom to 100%' })).toHaveText('125%')
  await controls.getByRole('button', { name: 'Read-only' }).click()
  await expect(palette).toHaveCount(0)
  const count = (await cards()).length
  await controls.getByRole('button', { name: 'Zoom to fit' }).click()
  const empty = await emptySpot()
  expect(empty, 'somewhere empty on the board').not.toBeNull()
  await page.mouse.dblclick(empty!.x, empty!.y)
  expect((await cards()).length).toBe(count)
  await controls.getByRole('button', { name: 'Read-only' }).click()
  await stubSaveDialog(app, join(dir, 'board.png'))
  await controls.getByRole('button', { name: 'Export as image' }).click()
  await expect.poll(() => (existsSync(join(dir, 'board.png')) ? readFileSync(join(dir, 'board.png')).subarray(1, 4).toString() : '')).toBe('PNG')
})
