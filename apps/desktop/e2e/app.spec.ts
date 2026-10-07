import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let dir: string
let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'universe-e2e-'))
  // UNIVERSE_E2E_EXECUTABLE runs the suite against a packaged build instead of the dev build.
  const executablePath = process.env.UNIVERSE_E2E_EXECUTABLE
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : [join(__dirname, '..')]), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, UNIVERSE_USER_DATA: join(dir, 'user-data') }
  })
  page = await app.firstWindow()
})

test.afterEach(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A tree row whose name is exactly `name`. */
const row = (name: string) => page.locator('.tree-row').filter({ has: page.locator('.tree-name').getByText(name, { exact: true }) })

/** Native file dialogs can't be driven by Playwright, so answer them from the main process. */
async function stubSaveDialog(path: string) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, path)
}

test('create a universe, build a hierarchy, undo/redo, and reopen it', async () => {
  await expect(page.getByRole('heading', { name: 'Universe' })).toBeVisible()
  await page.screenshot({ path: 'test-results/01-welcome.png' })

  const projectPath = join(dir, 'Aerth Saga.universe')
  await stubSaveDialog(projectPath)
  await page.getByRole('button', { name: 'New Universe…' }).click()
  await expect(page.locator('.tree-row.selected')).toHaveText(/Aerth Saga/)

  const inspector = page.locator('.inspector')
  const rename = async (name: string) => {
    const input = inspector.getByLabel('Name')
    await input.fill(name)
    await input.press('Enter')
    await expect(page.locator('.tree-row.selected')).toContainText(name)
  }

  for (const [button, name] of [
    ['+ Galaxy Cluster', 'Virgo Cluster'],
    ['+ Galaxy', 'Milky Way'],
    ['+ Star System', 'Sol']
  ] as const) {
    await inspector.getByRole('button', { name: button }).click()
    await rename(name)
  }
  for (const planet of ['Mercury', 'Aerth', 'Marrs']) {
    await row('Sol').click()
    await inspector.getByRole('button', { name: '+ Planet' }).click()
    await rename(planet)
  }
  await inspector.getByLabel('Notes').fill('Red and dusty.')
  await inspector.getByLabel('Name').click() // blur the notes field to commit it

  await row('Aerth').click()
  await inspector.getByRole('button', { name: '+ Moon' }).click()
  await rename('Luna')
  await row('Aerth').click()
  await inspector.getByRole('button', { name: '+ World surface' }).click()
  await expect(inspector.getByRole('button', { name: '+ World surface' })).toHaveCount(0)

  await row('Sol').click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/02-star-system.png' })

  // Delete Marrs, undo brings it back with its notes, redo removes it again.
  await row('Marrs').click()
  await inspector.getByRole('button', { name: 'Delete Marrs' }).click()
  await expect(row('Marrs')).toHaveCount(0)
  await page.getByRole('button', { name: '↶ Undo' }).click()
  await expect(row('Marrs')).toHaveCount(1)
  await expect(inspector.getByLabel('Notes')).toHaveValue('Red and dusty.')
  await page.getByRole('button', { name: '↷ Redo' }).click()
  await expect(row('Marrs')).toHaveCount(0)

  // Clicking a planet in the viewport zooms into it.
  await page.locator('.crumb button', { hasText: 'Sol' }).click()
  await row('Aerth').click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/03-planet.png' })

  // Everything was written to disk: close and reopen from the recent list.
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()!.items.find((i) => i.label === 'File')!.submenu!.items.find((i) => i.label === 'Close Project')!.click()
  })
  await expect(page.getByText('Recent')).toBeVisible()
  await page.getByRole('button', { name: /Aerth Saga/ }).click()
  await expect(row('Luna')).toHaveCount(1)
  await expect(row('Marrs')).toHaveCount(0)
})

test('rejects a node that does not fit the hierarchy', async () => {
  await stubSaveDialog(join(dir, 'Bad.universe'))
  await page.getByRole('button', { name: 'New Universe…' }).click()
  await expect(page.locator('.tree-row.selected')).toHaveText(/Bad/)
  const rootId = await page.evaluate(() => window.universe.getState().then((s) => s.project!.rootId))
  const result = await page.evaluate((id) => window.universe.execute({ type: 'node.create', payload: { parentId: id, kind: 'world' } }), rootId)
  expect(result).toEqual({ ok: false, error: 'A World cannot be placed inside a Universe' })
})
