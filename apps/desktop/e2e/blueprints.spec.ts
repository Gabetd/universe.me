import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { addChild, launch, newProject, type AppHandle } from './helpers'

let h: AppHandle
test.beforeEach(async () => {
  h = await launch()
})
test.afterEach(async () => {
  await h?.close()
})

const records = (page: Page) => page.evaluate(async () => (await window.universe.getState()).timeline)

/** A tiny binary glTF: a square pyramid, 2 units tall. */
function pyramidGlb(): Buffer {
  const positions = new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, 0, 2, 0])
  // Counter-clockwise seen from outside, as glTF expects.
  const indices = new Uint16Array([0, 4, 1, 1, 4, 2, 2, 4, 3, 3, 4, 0, 0, 1, 2, 0, 2, 3])
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer), Buffer.alloc(0)])
  const padded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)])
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.85, 0.75, 0.5, 1] } }],
    buffers: [{ byteLength: padded.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 5, type: 'VEC3', min: [-1, 0, -1], max: [1, 2, 1] },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' }
    ]
  }
  let text = Buffer.from(JSON.stringify(json))
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + text.length + 8 + padded.length, 8)
  const chunk = (type: number, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32LE(data.length, 0)
    head.writeUInt32LE(type, 4)
    return Buffer.concat([head, data])
  }
  return Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, padded)])
}

test('build a blueprint from parts, import a glTF model, and place both', async () => {
  const { app, page, dir } = h
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await newProject(h, 'Builders')
  await addChild(page, '+ Galaxy Cluster', 'Virgo')
  await addChild(page, '+ Galaxy', 'Milky Way')
  await addChild(page, '+ Star System', 'Sol')
  await addChild(page, '+ Planet', 'Terra')
  await addChild(page, '+ World surface', 'Terra Surface')
  await page.getByRole('button', { name: '🗺 Map' }).click()
  await expect(page.getByText('Generating terrain…')).toHaveCount(0, { timeout: 20_000 })

  // A keep: a stone block with a wooden roof.
  await page.getByRole('button', { name: '+ New blueprint' }).click()
  const builder = page.getByRole('dialog', { name: 'Blueprint builder' })
  await builder.getByLabel('Blueprint name').fill('Keep')
  await builder.getByLabel('H size').fill('18')
  await builder.getByRole('button', { name: '+ Part' }).click()
  const roof = builder.getByLabel('Part 2')
  await roof.getByLabel('Shape').selectOption('pyramid')
  await roof.getByLabel('Material').selectOption('wood')
  await roof.getByLabel('W size').fill('12')
  await roof.getByLabel('H size').fill('6')
  await roof.getByLabel('D size').fill('12')
  await roof.getByLabel('Y position').fill('18')
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'test-results/50-blueprint-builder.png' })
  // Aged to a ruin, the wooden roof is gone.
  await builder.getByLabel('Preview condition').fill('15')
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/51-blueprint-ruin.png' })
  await builder.getByRole('button', { name: 'Add to library' }).click()
  await expect(builder).toBeHidden()
  await expect.poll(async () => (await records(page)).blueprints.map((b) => [b.name, b.parts.length])).toEqual([['Keep', 2]])

  // Clicking it in the library starts placing it.
  await page.locator('.blueprint-row', { hasText: 'Keep' }).getByTitle('Place it').click()
  const click = async (x: number, y: number) => {
    const map = (await page.getByTestId('map').boundingBox())!
    await page.mouse.click(map.x + map.width * x, map.y + map.height * y)
  }
  await click(0.5, 0.45)
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await records(page)).structures.map((s) => s.name)).toEqual(['Keep'])

  // Import a model; it's stored in the project and decays as the chosen material.
  const file = join(dir, 'Obelisk.glb')
  writeFileSync(file, pyramidGlb())
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
  }, file)
  await page.getByRole('button', { name: 'Import 3D model…' }).click()
  await expect(builder).toBeVisible()
  await expect(builder.getByLabel('Blueprint name')).toHaveValue('Obelisk')
  await builder.getByLabel('Real height (m)').fill('40')
  await builder.getByLabel('Material').selectOption('megalith')
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'test-results/52-model-import.png' })
  await builder.getByRole('button', { name: 'Add to library' }).click()
  const obelisk = await expect.poll(async () => (await records(page)).blueprints.find((b) => b.name === 'Obelisk')?.model).toMatchObject({ material: 'megalith', heightM: 40 })
  void obelisk

  await page.locator('.blueprint-row', { hasText: 'Obelisk' }).getByTitle('Place it').click()
  await click(0.53, 0.45)
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await records(page)).structures.map((s) => s.name)).toEqual(['Keep', 'Obelisk'])
  await page.getByRole('button', { name: '🌐 Globe' }).click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'test-results/53-blueprints-globe.png' })
  expect(errors).toEqual([])
})
