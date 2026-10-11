import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { expect, inspector, menu, newWorld, row, shot, state, stubSaveDialog, test } from './helpers'

/** The folder the next open dialog answers with. */
async function stubOpenDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as typeof dialog.showOpenDialog
  }, path)
}

test('plugins: one from the template generates villages (undone as one), exports a wiki and a map, and names things; one that fails leaves nothing behind', async ({ h }) => {
  test.slow()
  const { app, page, dir } = h
  // No file manager opens in a test.
  await app.evaluate(({ shell }) => {
    shell.openPath = async () => ''
  })
  await newWorld(h, 'Plugins')
  const worldId = (await state(page, 'nodes')).find((n) => n.kind === 'world')!.id

  // Tools → Plugins…: a new plugin from the template, a working example.
  await menu(app, 'Tools', 'Plugins…')
  const manager = page.getByRole('dialog', { name: 'Plugins' })
  await expect(manager).toContainText('No plugins yet')
  await manager.getByRole('button', { name: '+ New plugin from the template' }).click()
  const mine = manager.getByRole('listitem', { name: 'My plugin 1' })
  await expect(mine).toBeVisible()
  await expect(mine.getByRole('group', { name: 'Scatter villages' })).toBeVisible()
  await shot(page, '160-plugins')

  // Its generator, with its options, on the selected world: villages on dry land, one step to undo.
  const villages = mine.getByRole('group', { name: 'Scatter villages' })
  await villages.getByLabel('How many').fill('4')
  await villages.getByRole('button', { name: 'Run' }).click()
  const note = page.getByRole('status', { name: 'Plugin run' })
  await expect(note).toContainText(/Founded 4 villages: /, { timeout: 60_000 })
  expect((await state(page, 'timeline')).structures.filter((s) => s.ownerId === worldId)).toHaveLength(4)
  await expect(mine.locator('.plugin-log')).toContainText('Its last run’s log')
  await note.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(async () => (await state(page, 'timeline')).structures.length).toBe(0)
  await menu(app, 'Edit', 'Redo')
  await expect.poll(async () => (await state(page, 'timeline')).structures.length).toBe(4)

  // Its exporters: a wiki (several files, in a folder picked) and a map (one file, saved where asked).
  const wikiDir = join(dir, 'wiki')
  mkdirSync(wikiDir)
  await stubOpenDialog(app, wikiDir)
  await mine.getByRole('group', { name: 'Wiki pages' }).getByRole('button', { name: 'Export…' }).click()
  await expect(note).toContainText(/saved \d+ files/, { timeout: 60_000 })
  expect(readFileSync(join(wikiDir, 'index.md'), 'utf8')).toMatch(/^# Terra Surface/)
  await stubSaveDialog(app, join(dir, 'map.png'))
  const map = mine.getByRole('group', { name: 'Map image' })
  await map.getByLabel('Width (pixels)').selectOption('512')
  await map.getByRole('button', { name: 'Export…' }).click()
  await expect(note).toContainText(/saved .*map\.png/, { timeout: 60_000 })
  expect(readFileSync(join(dir, 'map.png')).subarray(1, 4).toString()).toBe('PNG')
  await page.getByRole('button', { name: 'Close plugins' }).click()

  // The world's inspector runs them too; its name generator names the world from its right-click menu.
  await expect(inspector(page).getByRole('region', { name: 'Plugins' }).getByRole('group', { name: 'Scatter villages' })).toBeVisible()
  await row(page, 'Terra Surface').click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Name it: Names from the example plugin…' }).click()
  const names = page.getByRole('dialog', { name: 'Names from the example plugin' })
  const first = (await names.getByRole('button').filter({ hasNotText: '✕' }).first().textContent())!.trim()
  await names.getByRole('button', { name: first, exact: true }).click()
  await expect(row(page, first)).toHaveCount(1)

  // A plugin that adds something and then fails: nothing it did is kept, and it says why.
  const bad = join(dir, 'bad-plugin')
  mkdirSync(bad)
  writeFileSync(join(bad, 'plugin.json'), JSON.stringify({ id: 'bad', name: 'Bad plugin', version: '0.1.0', generators: [{ id: 'omens', title: 'Omens' }] }))
  writeFileSync(
    join(bad, 'main.js'),
    `export const generators = { async omens({ worldId }, universe) {
      await universe.call('create_event', { worldId, title: 'An omen', start: 1200 })
      throw new Error('The stars went dark')
    } }`
  )
  await menu(app, 'Tools', 'Plugins…')
  await stubOpenDialog(app, bad)
  await manager.getByRole('button', { name: 'Add a plugin folder…' }).click()
  const badEntry = manager.getByRole('listitem', { name: 'Bad plugin' })
  await badEntry.getByRole('group', { name: 'Omens' }).getByRole('button', { name: 'Run' }).click()
  await expect(note).toContainText('Bad plugin: The stars went dark')
  expect((await state(page, 'timeline')).events).toHaveLength(0)

  // Turned off, its generators aren't offered; removed, a folder of one's own stays where it is.
  await badEntry.getByLabel('Bad plugin on').uncheck()
  await expect(badEntry.getByRole('group', { name: 'Omens' })).toHaveCount(0)
  await badEntry.getByRole('button', { name: 'Remove' }).click()
  await expect(badEntry).toHaveCount(0)
  expect(existsSync(join(bad, 'plugin.json'))).toBe(true)
})
