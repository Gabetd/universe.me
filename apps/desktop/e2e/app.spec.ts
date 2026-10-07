import { expect, test } from '@playwright/test'
import { addChild, inspector, launch, newProject, row, writeNotes, type AppHandle } from './helpers'

let h: AppHandle
test.beforeEach(async () => {
  h = await launch()
})
test.afterEach(async () => {
  await h?.close()
})

test('create a universe, build a hierarchy, undo/redo, and reopen it', async () => {
  const { app, page } = h
  await expect(page.getByRole('heading', { name: 'Universe' })).toBeVisible()
  await page.screenshot({ path: 'test-results/01-welcome.png' })
  await newProject(h, 'Aerth Saga')

  await addChild(page, '+ Galaxy Cluster', 'Virgo Cluster')
  await addChild(page, '+ Galaxy', 'Milky Way')
  await addChild(page, '+ Star System', 'Sol')
  for (const planet of ['Mercury', 'Aerth', 'Marrs']) {
    await row(page, 'Sol').click()
    await addChild(page, '+ Planet', planet)
  }
  await writeNotes(page, 'Notes', 'Red and dusty.')

  await row(page, 'Aerth').click()
  await addChild(page, '+ Moon', 'Luna')
  await row(page, 'Aerth').click()
  await inspector(page).getByRole('button', { name: '+ World surface' }).click()
  await expect(inspector(page).getByRole('button', { name: '+ World surface' })).toHaveCount(0)

  await row(page, 'Sol').click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/02-star-system.png' })

  // Delete Marrs, undo brings it back with its notes, redo removes it again.
  await row(page, 'Marrs').click()
  await inspector(page).getByRole('button', { name: 'Delete Marrs' }).click()
  await expect(row(page, 'Marrs')).toHaveCount(0)
  await page.getByRole('button', { name: '↶ Undo' }).click()
  await expect(row(page, 'Marrs')).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveText('Red and dusty.')
  await page.getByRole('button', { name: '↷ Redo' }).click()
  await expect(row(page, 'Marrs')).toHaveCount(0)

  await page.locator('.crumb button', { hasText: 'Sol' }).click()
  await row(page, 'Aerth').click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/03-planet.png' })

  // Everything was written to disk: close and reopen from the recent list.
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()!.items.find((i) => i.label === 'File')!.submenu!.items.find((i) => i.label === 'Close Project')!.click()
  })
  await expect(page.getByText('Recent')).toBeVisible()
  await page.getByRole('button', { name: /Aerth Saga/ }).click()
  await expect(row(page, 'Luna')).toHaveCount(1)
  await expect(row(page, 'Marrs')).toHaveCount(0)
})

test('rejects a node that does not fit the hierarchy', async () => {
  const { page } = h
  await newProject(h, 'Bad')
  const rootId = await page.evaluate(() => window.universe.getState().then((s) => s.project!.rootId))
  const result = await page.evaluate((id) => window.universe.execute({ type: 'node.create', payload: { parentId: id, kind: 'world' } }), rootId)
  expect(result).toEqual({ ok: false, error: 'A World cannot be placed inside a Universe' })
})
