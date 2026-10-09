import { expect, httpMcp, inspector, newWorld, shot, state, test, tool } from './helpers'

test('the inconsistency detector: Claude reports what doesn’t fit (even in review mode), it shows in Warnings with marks on what it’s about, and it’s resolved or dismissed there', async ({ h }) => {
  const { app, page } = h
  await newWorld(h, 'Aerth')
  const worldId = (await state(page, 'nodes')).find((n) => n.kind === 'world')!.id
  const mcp = httpMcp(h)
  const { eventId } = await tool(mcp, 'create_event', { worldId, title: 'Mira crowned in Tarn', start: '10' })

  // Asked from the Warnings page: a request to paste into Claude.
  await page.getByRole('button', { name: /⚠ Warnings/ }).click()
  await expect(page.getByRole('region', { name: 'From Claude' })).toContainText('Nothing open')
  await page.getByRole('button', { name: 'Copy a request for Claude' }).click()
  await expect(page.getByRole('status', { name: 'Request for Claude' })).toHaveText('Copied: paste it into Claude.')
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain(`review_consistency prompt with worldId ${worldId}`)
  // The prompt Claude gets: the world, and the ids to say what a problem is about.
  const prompt = (await mcp('prompts/get', { name: 'review_consistency', arguments: { worldId } })) as unknown as { result: { messages: { content: { text: string } }[] } }
  expect(prompt.result.messages[0]!.content.text).toContain(`Mira crowned in Tarn = ${eventId}`)

  // Review mode holds changes to the world, not findings about it.
  await page.getByRole('button', { name: 'Connect AI' }).click()
  await page.getByRole('region', { name: 'Connect AI' }).getByLabel('Review AI changes before they apply').check()
  await page.getByRole('button', { name: 'Close connect AI' }).click()
  const report = {
    worldId,
    severity: 'contradiction',
    title: 'Mira is in two places at once',
    explanation: 'She is crowned in Tarn in the year 10, but her notes have her at sea all that year.',
    about: [{ kind: 'event', id: eventId }],
    suggestion: 'Crown her in 11, after she comes home.'
  }
  expect((await tool(mcp, 'report_inconsistency', report)).status).toBe('applied')
  const card = page.getByRole('article', { name: 'Mira is in two places at once' })
  await expect(card).toContainText('Suggested fix: Crown her in 11')
  await expect(page.getByRole('button', { name: /⚠ Warnings/ })).toContainText('1')
  // Marked where it shows: the event on the timeline.
  await expect(page.locator(`.tl-event[data-event-id="${eventId}"]`)).toHaveClass(/flagged/)
  await shot(page, '160-warnings')

  // What it's about opens in the inspector.
  await card.getByRole('group', { name: 'About' }).getByRole('button', { name: 'Mira crowned in Tarn' }).click()
  await expect(inspector(page).getByLabel('Event title')).toHaveValue('Mira crowned in Tarn')

  // Not a problem: it goes, its marks too, and Claude won't raise it again.
  await card.getByRole('button', { name: 'Not a problem' }).click()
  await expect(page.getByRole('region', { name: 'From Claude' })).toContainText('Nothing open')
  await expect(page.locator(`.tl-event[data-event-id="${eventId}"]`)).not.toHaveClass(/flagged/)
  expect(await tool(mcp, 'report_inconsistency', report)).toMatchObject({ status: 'already reported', findingStatus: 'dismissed' })
  const { findings } = await tool(mcp, 'list_inconsistencies', { worldId })
  expect(findings).toEqual([expect.objectContaining({ status: 'dismissed', title: 'Mira is in two places at once' })])
})
