import type { Locator, Page } from '@playwright/test'
import { clickAt, expect, inspector, newWorld, openMap, row, setPlayhead, state, test } from './helpers'

const panel = (page: Page) => page.locator('.inspector-panel')
/** Where a control is on screen. */
const shownAt = async (target: Locator) => (await target.boundingBox())?.y

/**
 * Changes a setting part way down the inspector (scrolled, so a jump shows),
 * and checks it's still where it was on screen once the change is saved and
 * whatever shows it has caught up. The control is put in the middle of the
 * panel first, then scrolled on as far as it stays in full view: at the
 * panel's edge, the browser itself scrolls a control into view as it's
 * focused, which isn't the panel moving.
 */
async function stays(page: Page, target: Locator, change: () => Promise<unknown>, saved: () => Promise<unknown>): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  const room = Math.floor((await target.boundingBox())!.y - (await panel(page).boundingBox())!.y) - 1
  await panel(page).evaluate((el, by) => el.scrollBy(0, by), Math.min(40, room))
  expect(await panel(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  const before = await shownAt(target)
  const [box, shown] = [await target.boundingBox(), await panel(page).boundingBox()]
  expect(box!.y >= shown!.y && box!.y + box!.height <= shown!.y + shown!.height, 'the control is in full view before it changes').toBe(true)
  const was = await saved()
  await change()
  await expect.poll(saved).not.toEqual(was)
  // Parts that fill in later (lists, charts) have a moment to.
  await page.waitForTimeout(1000)
  expect(await shownAt(target)).toBe(before)
}

/** Nudges a slider with the keyboard, which saves it on release as a drag does. */
const nudge = (slider: Locator) => async () => {
  await slider.focus()
  await slider.press('ArrowRight')
  await slider.blur()
}

test('a settings panel stays where it is when a setting changes', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Aerth')
  const world = () => page.evaluate(async () => (await window.universe.getState()).worlds[0]!)
  const node = () => page.evaluate(async () => (await window.universe.getState()).nodes.find((n) => n.kind === 'world')!)
  const ins = inspector(page)

  /** Unlocks the options, and waits until they show unlocked (so nothing is still changing as the next one is measured). */
  const customize = async () => {
    const button = ins.getByRole('button', { name: 'Customize' })
    if (await button.isVisible()) await button.click()
    await expect(ins.getByText('Custom world: set the options below')).toBeVisible()
  }
  await customize()
  const land = ins.getByRole('group', { name: 'Land type' })
  await stays(
    page,
    land,
    () => land.getByRole('button').last().click(),
    async () => (await world()).settings.terrain.landform
  )

  const temperature = ins.getByRole('slider', { name: 'Temperature', exact: true })
  await stays(page, temperature, nudge(temperature), async () => (await world()).settings.terrain.temperature)

  // Near the bottom of the panel, where it used to jump to the top: the whole panel was rebuilt, and was short until its lists filled in again.
  const sea = ins.getByRole('slider', { name: 'Sea level change' })
  await stays(page, sea, nudge(sea), async () => (await world()).settings.seaLevel)
  const erosion = ins.getByRole('slider', { name: 'Erosion speed' })
  await stays(page, erosion, nudge(erosion), async () => (await world()).settings.erosionSpeed)
  const reset = ins.getByRole('button', { name: 'Reset sculpting' })
  await stays(
    page,
    reset,
    () => reset.click(),
    async () => (await world()).terrainRevision
  )

  // A seed: the text under it changes, and the field stays put.
  const seed = ins.getByLabel('Seed', { exact: true })
  await stays(
    page,
    seed,
    async () => {
      await seed.fill('dragons')
      await seed.press('Enter')
    },
    async () => (await world()).settings.seedText
  )
  await customize()

  // A change to the world's own record (its shape's seed), which the whole form shows.
  const shape = ins.getByRole('button', { name: '🎲 New shape' })
  await stays(
    page,
    shape,
    () => shape.click(),
    async () => (await node()).seed
  )

  const name = ins.getByLabel('Name', { exact: true })
  await stays(
    page,
    name,
    async () => {
      await name.fill('Aerth Below')
      await name.press('Enter')
    },
    async () => (await node()).name
  )

  // The theme editor: a theme made from a preset, then opened from the library.
  await ins.getByRole('button', { name: 'New theme from the playhead' }).click()
  await ins
    .getByRole('button', { name: /^Edit / })
    .first()
    .click()
  const theme = () => page.evaluate(async () => (await window.universe.getState()).timeline.themes[0]!)
  const lighting = ins.getByRole('combobox', { name: 'Lighting' })
  await stays(
    page,
    lighting,
    () => lighting.selectOption({ index: 2 }),
    async () => (await theme()).lighting
  )
  const type = ins.getByRole('combobox', { name: 'Type', exact: true })
  await stays(
    page,
    type,
    () => type.selectOption('mono'),
    async () => (await theme()).typography
  )

  // A planet's orbit.
  await row(page, 'Terra').click()
  const day = ins.getByRole('textbox', { name: 'Day (hours)' })
  await stays(
    page,
    day,
    async () => {
      await day.fill('30')
      await day.press('Enter')
    },
    () =>
      page.evaluate(async () => {
        const s = await window.universe.getState()
        const terra = s.nodes.find((n) => n.name === 'Terra')!
        return s.timeline.orbits.find((o) => o.ownerId === terra.id)?.rotationHours
      })
  )
})

test('a structure’s panel stays where it is when its settings change', async ({ h }) => {
  const { page } = h
  await newWorld(h, 'Kingdoms')
  await openMap(page)
  await setPlayhead(page, '1000')
  await page.getByRole('button', { name: 'Place structure' }).click()
  await page.getByLabel('Blueprint to place').selectOption({ label: 'Stone castle' })
  await clickAt(page, 'map', [0.5, 0.45])
  await page.keyboard.press('Escape')
  await expect(inspector(page).getByLabel('Condition over time')).toBeVisible()
  const structure = async () => (await state(page, 'timeline')).structures[0]!
  const maintained = inspector(page).getByLabel(/Maintained from/)
  await stays(
    page,
    maintained,
    () => maintained.uncheck(),
    async () => JSON.stringify(await state(page, 'timeline'))
  )
  const name = inspector(page).getByLabel('Structure name')
  await stays(
    page,
    name,
    async () => {
      await name.fill('The Old Keep')
      await name.press('Enter')
    },
    async () => (await structure()).name
  )
})
