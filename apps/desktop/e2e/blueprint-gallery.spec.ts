import { expect, test } from '@playwright/test'
import { BUILTIN_BLUEPRINTS } from '@universe/core'
import { addChild, launch, newProject, type AppHandle } from './helpers'

let h: AppHandle
test.beforeEach(async () => {
  h = await launch()
})
test.afterEach(async () => {
  await h?.close()
})

// Renders every built-in blueprint in the builder's preview, pristine and as a ruin.
test('every built-in blueprint renders', async () => {
  test.setTimeout(300_000)
  const { page } = h
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await newProject(h, 'Gallery')
  await addChild(page, '+ Galaxy Cluster', 'Virgo')
  await addChild(page, '+ Galaxy', 'Milky Way')
  await addChild(page, '+ Star System', 'Sol')
  await addChild(page, '+ Planet', 'Terra')
  await addChild(page, '+ World surface', 'Terra Surface')
  const builder = page.getByRole('dialog', { name: 'Blueprint builder' })
  for (const [i, b] of BUILTIN_BLUEPRINTS.entries()) {
    await page.locator('.blueprint-row').filter({ hasText: new RegExp(`^.{0,3}${b.name.replace(/[()]/g, '\\$&')}`) }).getByRole('button', { name: 'Copy' }).click()
    await expect(builder).toBeVisible()
    await page.waitForTimeout(400)
    await builder.getByTestId('blueprint-preview').screenshot({ path: `test-results/gallery/${String(i).padStart(2, '0')}-${b.id.slice(8)}.png` })
    await builder.getByLabel('Preview condition').fill('12')
    await page.waitForTimeout(200)
    await builder.getByTestId('blueprint-preview').screenshot({ path: `test-results/gallery/${String(i).padStart(2, '0')}-${b.id.slice(8)}-ruin.png` })
    await builder.getByRole('button', { name: 'Cancel' }).click()
  }
  expect(errors).toEqual([])
})
