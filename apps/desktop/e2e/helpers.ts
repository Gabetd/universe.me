import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'

export interface AppHandle {
  app: ElectronApplication
  page: Page
  dir: string
  close(): Promise<void>
}

/** Launches the app with a throwaway profile. UNIVERSE_E2E_EXECUTABLE tests a packaged build instead of the dev build. */
export async function launch(): Promise<AppHandle> {
  const dir = mkdtempSync(join(tmpdir(), 'universe-e2e-'))
  const executablePath = process.env.UNIVERSE_E2E_EXECUTABLE
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      ...(executablePath ? [] : [join(__dirname, '..')]),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      // CI machines have no GPU; this allows WebGL on the software renderer.
      '--enable-unsafe-swiftshader'
    ],
    env: { ...process.env, UNIVERSE_USER_DATA: join(dir, 'user-data') }
  })
  const page = await app.firstWindow()
  return {
    app,
    page,
    dir,
    close: async () => {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Native file dialogs can't be driven by Playwright, so answer them from the main process. */
export async function stubSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, path)
}

export async function newProject({ app, page, dir }: AppHandle, name: string): Promise<string> {
  const path = join(dir, `${name}.universe`)
  await stubSaveDialog(app, path)
  await page.getByRole('button', { name: 'New Universe…' }).click()
  await expect(page.locator('.tree-row.selected')).toHaveText(new RegExp(name))
  return path
}

/** A tree row whose name is exactly `name`. */
export const row = (page: Page, name: string) =>
  page.locator('.tree-row').filter({ has: page.locator('.tree-name').getByText(name, { exact: true }) })

export const inspector = (page: Page) => page.locator('.inspector')

/** Adds a child to the selected node via the inspector and renames it. */
export async function addChild(page: Page, button: string, name: string): Promise<void> {
  await inspector(page).getByRole('button', { name: button, exact: true }).click()
  const input = inspector(page).getByLabel('Name', { exact: true })
  await input.fill(name)
  await input.press('Enter')
  await expect(page.locator('.tree-row.selected')).toContainText(name)
}

/** Types into a rich-text notes editor and commits it by moving focus away. */
export async function writeNotes(page: Page, label: string, text: string): Promise<void> {
  const editor = page.getByRole('textbox', { name: label, exact: true })
  await editor.click()
  await page.keyboard.type(text)
  await page.locator('.panel-title').click()
}
