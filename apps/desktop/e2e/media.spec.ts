import type { Page } from '@playwright/test'
import { join } from 'node:path'
import { clickAt, expect, fill, inspector, newWorld, openMap, setPlayhead, shot, state, test } from './helpers'

// A picture Blender rendered of a scene, and that scene as Blender 5.2 saved it (compressed, with its thumbnail).
const PICTURE = join(__dirname, 'fixtures', 'scene.jpg')
const SCENE = join(__dirname, '..', 'src', 'renderer', 'src', 'media', 'fixtures', 'blender-5.2.blend')

const timeline = (page: Page) => state(page, 'timeline')
const gallery = (page: Page, label: string) => inspector(page).getByRole('group', { name: label })

test('characters and events keep pictures and Blender scenes, seen large when opened', async ({ h }) => {
  test.slow()
  const { page } = h
  await newWorld(h, 'Portraits')
  await openMap(page)
  await setPlayhead(page, '1000')
  await inspector(page).getByRole('button', { name: '+ Character' }).click()
  await clickAt(page, 'map', [0.4, 0.4])
  await fill(page, 'Character name', 'Aria')

  // Both at once, from the file picker: one change.
  const pictures = gallery(page, 'Pictures and models')
  await pictures.getByLabel('Add to Pictures and models').setInputFiles([PICTURE, SCENE])
  await expect.poll(async () => (await timeline(page)).characters[0]?.media?.map((m) => [m.name, m.kind])).toEqual([
    ['scene.jpg', 'image'],
    ['blender-5.2.blend', 'blend']
  ])
  await expect(pictures.getByRole('img', { name: 'scene.jpg' })).toBeVisible()
  // The .blend file's tile is the thumbnail Blender saved in it.
  await expect(pictures.getByRole('button', { name: 'Open blender-5.2.blend' }).locator('canvas')).toBeVisible()
  await shot(page, '86-character-pictures')

  // Opened, the picture is shown large; → goes on to the scene, drawn from its meshes.
  await pictures.getByRole('button', { name: 'Open scene.jpg' }).click()
  const viewer = page.getByRole('dialog', { name: 'scene.jpg' })
  await expect(viewer.locator('img.media-picture')).toBeVisible()
  await expect.poll(() => viewer.locator('img.media-picture').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480)
  await page.keyboard.press('ArrowRight')
  const scene = page.getByRole('dialog', { name: 'blender-5.2.blend' }).getByTestId('blend-view')
  await expect(scene).toHaveAttribute('data-meshes', '3')
  await expect(scene).toHaveAttribute('data-triangles', '46')
  await expect(scene).toContainText('Blender 5.2 · 3 meshes · 46 triangles · 1 other object')
  await expect(page.getByRole('button', { name: 'Open a copy in Blender' })).toBeVisible()
  await shot(page, '87-blend-scene', { wait: 500 })
  await page.getByRole('button', { name: 'Close the viewer' }).click()

  // Taken off, and back with undo.
  await pictures.getByRole('button', { name: 'Remove scene.jpg' }).click()
  await expect.poll(async () => (await timeline(page)).characters[0]?.media?.length).toBe(1)
  await page.getByRole('button', { name: '↶ Undo' }).click()
  await expect.poll(async () => (await timeline(page)).characters[0]?.media?.length).toBe(2)
  await expect(pictures.getByRole('img', { name: 'scene.jpg' })).toBeVisible()

  // An event's scenes; a file that's neither a picture nor a Blender file is turned away.
  await page.getByRole('button', { name: '+ Event' }).click()
  await fill(page, 'Event title', 'The Council')
  const scenes = gallery(page, 'Scenes')
  await scenes.getByLabel('Add to Scenes').setInputFiles({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('not really a picture') })
  await expect(page.getByRole('alert')).toContainText('notes.png isn’t a picture')
  await scenes.getByLabel('Add to Scenes').setInputFiles(PICTURE)
  await expect.poll(async () => (await timeline(page)).events.find((e) => e.title === 'The Council')?.media?.map((m) => m.name)).toEqual(['scene.jpg'])
  await expect(scenes.getByRole('img', { name: 'scene.jpg' })).toBeVisible()
})
