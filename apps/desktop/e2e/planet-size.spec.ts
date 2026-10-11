import { expect, inspector, newWorld, row, state, test } from './helpers'

test('a planet’s size on the Earth scale (10 is Earth), its mass following it until unlinked', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Sizes')
  const radius = async () => (await state(page, 'worlds'))[0]!.settings.radiusKm
  const panel = inspector(page)
  const enter = async (label: string, value: string) => {
    const field = panel.getByLabel(label, { exact: true })
    await field.fill(value)
    await field.press('Enter')
  }
  await expect(panel.getByRole('slider', { name: 'Planet size' })).toHaveValue('10')

  // Half Earth's size: its radius half Earth's, and it weighs what a planet that size does.
  await enter('Size (Earth = 10)', '5')
  await expect.poll(radius).toBe(3186)
  const link = panel.getByLabel(/Mass follows size/)
  await expect(link).toBeChecked()
  await expect(panel.getByText(/· 0\.0834 Earth masses/)).toBeVisible()

  // Unlinked, its mass stays what it was while its size changes.
  await link.uncheck()
  await enter('Size (Earth = 10)', '20')
  await expect.poll(radius).toBe(12_742)
  await expect(panel.getByText(/· 0\.0834 Earth masses/)).toBeVisible()

  // On the planet's orbit: linked again, setting its mass sets its size.
  await row(page, 'Terra').click()
  await panel.getByLabel(/Mass follows size/).check()
  await enter('Mass (Earths)', '1')
  await expect.poll(radius).toBe(6371)
  await row(page, 'Terra Surface').click()
  await expect(panel.getByLabel('Size (Earth = 10)', { exact: true })).toHaveValue('10')
})
