import { addChild, closeProject, expect, inspector, menu, newProject, row, shot, state, test, writeNotes } from './helpers'

test('create a universe, build a hierarchy, undo/redo, and reopen it', async ({ h }) => {
  const { app, page } = h
  await expect(page.getByRole('heading', { name: 'Universe' })).toBeVisible()
  await shot(page, '01-welcome')
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
  await shot(page, '02-star-system', { wait: 300 })

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
  await shot(page, '03-planet', { wait: 300 })

  // Everything was written to disk: close and reopen from the recent list.
  await closeProject(app)
  await expect(page.getByText('Recent')).toBeVisible()
  await page.getByRole('button', { name: /Aerth Saga/ }).click()
  await expect(row(page, 'Luna')).toHaveCount(1)
  await expect(row(page, 'Marrs')).toHaveCount(0)
})

test('rejects a node that does not fit the hierarchy', async ({ h }) => {
  const { page } = h
  await newProject(h, 'Bad')
  const rootId = (await state(page, 'project'))!.rootId
  const result = await page.evaluate((id) => window.universe.execute({ type: 'node.create', payload: { parentId: id, kind: 'world' } }), rootId)
  expect(result).toEqual({ ok: false, error: 'A World cannot be placed inside a Universe' })
})

test('Edit → Undo goes to the focused notes first, then to the project', async ({ h }) => {
  const { app, page } = h
  await newProject(h, 'Menus')
  await addChild(page, '+ Galaxy Cluster', 'Virgo')
  const notes = page.getByRole('textbox', { name: 'Notes', exact: true })
  await notes.click()
  await page.keyboard.type('Draft')
  await menu(app, 'Edit', 'Undo')
  await expect(notes).not.toContainText('Draft')
  await expect(row(page, 'Virgo')).toHaveCount(1)

  await page.locator('.panel-title').click()
  await menu(app, 'Edit', 'Undo')
  await expect(row(page, 'Virgo')).toHaveCount(0)
})
