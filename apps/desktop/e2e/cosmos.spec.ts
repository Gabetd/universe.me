import type { Page } from '@playwright/test'
import { expect, inspector, newProject, row, shot, SLOW, state, test, wheel, type Point } from './helpers'

const nodes = (page: Page) => state(page, 'nodes')

/** The viewport's box once any zoom between levels has played out (the arriving view is scaled until then). */
async function viewportBox(page: Page) {
  await expect(page.locator('.zoom-arrive')).toHaveCount(0)
  return (await page.getByTestId('viewport').boundingBox())!
}

/** Scrolls over the middle of the viewport. */
async function scroll(page: Page, dy: number, times: number) {
  await viewportBox(page)
  await wheel(page, page.getByTestId('viewport'), dy, times)
}

/**
 * Turns the wheel over the middle of the viewport a notch at a time until `done` passes. Changing
 * level takes a few notches in a row, and Chromium may merge wheel events, so it isn't a fixed count.
 */
async function scrollUntil(page: Page, dy: number, done: () => Promise<void>) {
  await viewportBox(page)
  await expect(async () => {
    await wheel(page, page.getByTestId('viewport'), dy)
    await done()
  }).toPass({ timeout: SLOW })
}

/**
 * Where the view points at something (it shows a pointer cursor), nearest its middle: spots 6 px
 * apart, pointed at inside the page in one go. The hover is undone after, so the real one is seen anew.
 */
const pointable = (page: Page) =>
  page.getByTestId('viewport').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect()
    const move = (x: number, y: number) => canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + x, clientY: rect.top + y, bubbles: true }))
    const spots: [number, number][] = []
    for (let dy = -258; dy <= 258; dy += 6) for (let dx = -258; dx <= 258; dx += 6) if (Math.hypot(dx, dy) < 260) spots.push([dx, dy])
    spots.sort((a, b) => Math.hypot(...a) - Math.hypot(...b))
    for (const [dx, dy] of spots) {
      const [x, y] = [rect.width / 2 + dx, rect.height / 2 + dy]
      move(x, y)
      if (canvas.style.cursor !== 'pointer') continue
      move(-1e4, -1e4)
      return { x, y }
    }
    return null
  })

/**
 * Clicks the generated thing nearest the middle of the view, once hovering it shows its card.
 * Found, hovered and checked together, and again if need be: a galaxy's stars come from a worker
 * after the view first draws, so what was under a spot can move before the mouse gets there (and a
 * mouse that doesn't move again isn't asked again).
 */
async function clickNearestGenerated(page: Page) {
  const box = await viewportBox(page)
  const card = page.locator('.cosmos-card', { hasText: 'not claimed yet' })
  let at: Point | undefined
  await expect(async () => {
    const spot = await pointable(page)
    expect(spot, 'something generated near the middle of the view').not.toBeNull()
    at = { x: box.x + spot!.x, y: box.y + spot!.y }
    // From somewhere else: if the mouse is already there (the middle, after scrolling), moving to it sends no pointer event, and nothing is hovered.
    await page.mouse.move(box.x + 2, box.y + 2)
    await page.mouse.move(at.x, at.y)
    await expect(card).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: SLOW })
  await page.mouse.click(at!.x, at!.y)
}

test('scale navigation: claim a cluster, a galaxy and a star from what the seeds generate, zoom in and out between levels', async ({ h }) => {
  // Four levels, each drawn in software on CI machines.
  test.slow()
  const { page } = h
  await newProject(h, 'Cosmos')

  // The universe: clusters strung along the cosmic web, all generated.
  await expect(page.getByTestId('viewport')).toBeVisible()
  await shot(page, '100-universe', { wait: 500 })

  // Claim a cluster and go there.
  await clickNearestGenerated(page)
  await page.getByRole('button', { name: 'Claim and go there' }).click()
  await expect.poll(async () => (await nodes(page)).filter((n) => n.kind === 'galaxy_cluster').length).toBe(1)
  await expect(page.locator('.viewport-overlay.top')).toContainText('Galaxy Cluster view')
  await shot(page, '101-cluster', { wait: 600 })

  // A galaxy in it.
  await clickNearestGenerated(page)
  await page.getByRole('button', { name: 'Claim and go there' }).click()
  await expect(page.locator('.viewport-overlay.top')).toContainText('Galaxy view')
  await shot(page, '102-galaxy', { wait: 600 })

  // Zoomed in, single stars appear; claiming one makes a star system with that star's mass.
  await scroll(page, -400, 7)
  await shot(page, '103-galaxy-stars', { wait: 300 })
  await clickNearestGenerated(page)
  const name = (await page.locator('.cosmos-card b').textContent())!
  await page.getByRole('button', { name: 'Claim and go there' }).click()
  await expect(page.locator('.viewport-overlay.top')).toContainText(name)
  await expect(page.locator('.viewport-overlay.top')).toContainText('Star System view')
  const system = (await nodes(page)).find((n) => n.kind === 'star_system')!
  expect(system.name).toBe(name)
  expect(system.position.x !== 0 || system.position.y !== 0).toBe(true)
  expect((await state(page, 'timeline')).stars[0]?.ownerId).toBe(system.id)

  // The star comes with the planets its seed makes, drawn faintly until claimed: claim one, as a world.
  await shot(page, '104-system-planets', { wait: 600 })
  const claimPlanet = inspector(page).getByRole('button', { name: /^Claim / }).first()
  const planetName = (await claimPlanet.textContent())!.replace(/^Claim /, '')
  expect(planetName).toBe(`${name} b`)
  await claimPlanet.click()
  await expect(page.locator('.viewport-overlay.top')).toContainText(planetName)
  const all = await nodes(page)
  const planet = all.find((n) => n.name === planetName)!
  expect(planet.parentId).toBe(system.id)
  expect(all.find((n) => n.parentId === planet.id)?.kind).toBe('world')
  expect((await state(page, 'timeline')).orbits.some((o) => o.ownerId === planet.id)).toBe(true)
  await shot(page, '105-claimed-planet', { wait: 600 })

  // Scrolling out goes back up to the system; the breadcrumb straight to the galaxy, centred on the star.
  await scrollUntil(page, 400, () => expect(page.locator('.viewport-overlay.top')).toContainText('Star System view', { timeout: 1000 }))
  const galaxy = all.find((n) => n.kind === 'galaxy')!
  await page.getByRole('navigation', { name: 'Location' }).getByRole('button', { name: galaxy.name }).click()
  await expect(page.locator('.viewport-overlay.top')).toContainText('Galaxy view')
  await expect(page.getByText(name, { exact: false }).first()).toBeAttached()
  // Escape goes up again, to the cluster.
  await page.keyboard.press('Escape')
  await expect(page.locator('.viewport-overlay.top')).toContainText('Galaxy Cluster view')

  // Right-click adds a galaxy right there.
  const box = await viewportBox(page)
  await page.mouse.click(box.x + 60, box.y + box.height - 80, { button: 'right' })
  await page.getByRole('menuitem', { name: 'New galaxy here' }).click()
  await expect.poll(async () => (await nodes(page)).filter((n) => n.kind === 'galaxy').length).toBe(2)
  const made = (await nodes(page)).find((n) => n.kind === 'galaxy' && n.name === 'New Galaxy')!
  expect(made.position.x !== 0 || made.position.y !== 0).toBe(true)
  await expect(row(page, 'New Galaxy')).toBeVisible()
  await expect(inspector(page)).toBeVisible()
})
