import { join } from 'node:path'
import { expect, inspector, openGlobe, playhead, row, setPlayhead, shot, state, stubSaveDialog, test } from './helpers'

test('the sample universe: from the start screen, a world with a history to look around in, opened on the world', async ({ h }) => {
  test.slow()
  const { app, page, dir } = h
  await stubSaveDialog(app, join(dir, 'Calder (sample).universe'))
  await page.getByRole('button', { name: 'Explore a sample universe' }).click()

  // Opened on its world, with what the sample holds.
  await expect(page.locator('.tree-row.selected')).toHaveText(/Calder Surface/)
  await expect(row(page, 'The Spindle')).toBeVisible()
  await expect(inspector(page).getByText('A sample world to look around in.', { exact: false })).toBeVisible()
  const timeline = await state(page, 'timeline')
  expect(timeline.events.map((e) => e.title)).toContain('Battle of Kingsbridge')
  expect(timeline.structures.map((s) => s.name)).toEqual(expect.arrayContaining(['Varn Castle', 'Eastwatch Light', 'The Nine Maidens']))
  expect((await state(page, 'regions')).map((r) => r.name)).toContain('Kingdom of Varn')
  // None of it is waiting to be undone, and none of it is the AI's.
  expect([await state(page, 'canUndo'), await state(page, 'aiChanges')]).toEqual([false, 0])

  // Its present day, after the Thaw; then back in the Long Winter, on the globe, which faces the kingdom.
  await expect(playhead(page)).toHaveValue(/1450/)
  await openGlobe(page)
  await setPlayhead(page, '1250')
  await shot(page, '190-sample-universe')
})
