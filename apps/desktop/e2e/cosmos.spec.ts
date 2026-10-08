import { expect, test, type Page } from '@playwright/test'
import { inspector, launch, newProject, row, type AppHandle } from './helpers'

let h: AppHandle
test.beforeEach(async () => {
  h = await launch()
})
test.afterEach(async () => {
  await h?.close()
})

const nodes = (page: Page) => page.evaluate(async () => (await window.universe.getState()).nodes)
const stars = (page: Page) => page.evaluate(async () => (await window.universe.getState()).timeline.stars)

/** The viewport's box once any zoom between levels has played out (the arriving view is scaled until then). */
async function viewportBox(page: Page) {
  await expect(page.locator('.zoom-arrive')).toHaveCount(0)
  return (await page.getByTestId('viewport').boundingBox())!
}

/** Scrolls over the middle of the viewport. */
async function scroll(page: Page, dy: number, times: number) {
  const box = await viewportBox(page)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < times; i++) await page.mouse.wheel(0, dy)
}

/** Clicks the generated thing nearest the middle of the view (the view reports what's on it). */
async function clickNearestGenerated(page: Page) {
  const box = await viewportBox(page)
  // Sweep outward from the middle until a card for something not yet claimed appears.
  for (let r = 0; r < 260; r += 6) {
    for (let a = 0; a < 16; a++) {
      const x = box.x + box.width / 2 + Math.cos((a / 16) * Math.PI * 2) * r
      const y = box.y + box.height / 2 + Math.sin((a / 16) * Math.PI * 2) * r
      await page.mouse.move(x, y)
      if (await page.locator('.cosmos-card', { hasText: 'not claimed yet' }).count()) {
        await page.mouse.click(x, y)
        return
      }
    }
  }
  throw new Error('Nothing generated near the middle of the view')
}

test('scale navigation: claim a cluster, a galaxy and a star from what the seeds generate, zoom in and out between levels', async () => {
  test.setTimeout(180_000)
  const { page } = h
  await newProject(h, 'Cosmos')

  // The universe: clusters strung along the cosmic web, all generated.
  await expect(page.getByTestId('viewport')).toBeVisible()
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'test-results/100-universe.png' })

  // Claim a cluster and go there.
  await clickNearestGenerated(page)
  await page.getByRole('button', { name: 'Claim and go there' }).click()
  await expect.poll(async () => (await nodes(page)).filter((n) => n.kind === 'galaxy_cluster').length).toBe(1)
  await expect(page.locator('.viewport-overlay.top')).toContainText('Galaxy Cluster view')
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'test-results/101-cluster.png' })

  // A galaxy in it.
  await clickNearestGenerated(page)
  await page.getByRole('button', { name: 'Claim and go there' }).click()
  await expect(page.locator('.viewport-overlay.top')).toContainText('Galaxy view')
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'test-results/102-galaxy.png' })

  // Zoomed in, single stars appear; claiming one makes a star system with that star's mass.
  await scroll(page, -400, 7)
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/103-galaxy-stars.png' })
  await clickNearestGenerated(page)
  const name = (await page.locator('.cosmos-card b').textContent())!
  await page.getByRole('button', { name: 'Claim and go there' }).click()
  await expect(page.locator('.viewport-overlay.top')).toContainText(name)
  await expect(page.locator('.viewport-overlay.top')).toContainText('Star System view')
  const system = (await nodes(page)).find((n) => n.kind === 'star_system')!
  expect(system.name).toBe(name)
  expect(system.position.x !== 0 || system.position.y !== 0).toBe(true)
  expect((await stars(page))[0]?.ownerId).toBe(system.id)

  // Scrolling out goes back up, to the galaxy, centred on the star just left.
  await scroll(page, 400, 3)
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
