import { describe, expect, it } from 'vitest'
import { CommandBus, MemoryStore, bytesToBase64, createRootUniverse, sniffMedia, zstdFrames, type Command } from './index'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const BLEND = new TextEncoder().encode('BLENDER-v402REND....')

function setup() {
  const store = new MemoryStore()
  let n = 0
  const bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 1 } })
  const run = (type: string, payload: object) => bus.execute({ type, payload } as Command)
  let world = createRootUniverse(store, 'U').id
  for (const kind of ['galaxy_cluster', 'galaxy', 'star_system', 'body', 'world']) world = run('node.create', { parentId: world, kind, name: kind }).targetId!
  return { store, bus, run, world }
}

describe('pictures and Blender scenes on characters and events', () => {
  it('are kept in the project and listed on the record, one undo each way', () => {
    const { store, bus, run, world } = setup()
    const ada = run('character.create', { ownerId: world, name: 'Ada', born: 0 }).targetId!
    const to = { kind: 'character', id: ada }
    run('media.attach', { to, assetId: 'portrait', name: 'ada.png', data: bytesToBase64(PNG) })
    run('media.attach', { to, assetId: 'model', name: 'ada.blend', data: bytesToBase64(BLEND) })
    expect(store.records('character').get(ada)!.media).toEqual([
      { assetId: 'portrait', name: 'ada.png', kind: 'image' },
      { assetId: 'model', name: 'ada.blend', kind: 'blend' }
    ])
    expect(store.assets.get('portrait')).toMatchObject({ mime: 'image/png', data: PNG })
    expect(store.assets.get('model')?.mime).toBe('application/x-blender')

    bus.undo()
    expect(store.records('character').get(ada)!.media).toHaveLength(1)
    expect(store.assets.get('model')).toBeUndefined()
    bus.redo()
    expect(store.assets.get('model')?.data).toEqual(BLEND)

    run('media.detach', { to, assetId: 'portrait' })
    expect(store.records('character').get(ada)!.media!.map((m) => m.assetId)).toEqual(['model'])
    expect(store.assets.get('portrait')).toBeUndefined()
    bus.undo()
    expect(store.records('character').get(ada)!.media!.map((m) => m.assetId)).toEqual(['portrait', 'model'])
    expect(store.assets.get('portrait')?.data).toEqual(PNG)
  })

  it('go on events too, and only files that are pictures or Blender scenes', () => {
    const { store, run, world } = setup()
    const battle = run('event.create', { ownerId: world, title: 'The battle', start: 0 }).targetId!
    const to = { kind: 'event', id: battle }
    run('media.attach', { to, assetId: 'scene', name: 'field.blend', data: bytesToBase64(BLEND) })
    expect(store.records('event').get(battle)!.media).toEqual([{ assetId: 'scene', name: 'field.blend', kind: 'blend' }])
    expect(() => run('media.attach', { to, assetId: 'text', name: 'notes.png', data: bytesToBase64(new TextEncoder().encode('just some words')) })).toThrow('isn’t a picture')
    expect(() => run('media.attach', { to, assetId: 'scene', name: 'again.png', data: bytesToBase64(PNG) })).toThrow('already exists')
    expect(() => run('media.detach', { to, assetId: 'nothing' })).toThrow('isn’t on this event')
    expect(() => run('media.attach', { to: { kind: 'event', id: 'gone' }, assetId: 'x', name: 'x.png', data: bytesToBase64(PNG) })).toThrow()
  })

  it('are told apart by their first bytes, not their names', () => {
    expect(sniffMedia(PNG, 'picture.jpg')).toBe('image/png')
    expect(sniffMedia(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'x')).toBe('image/jpeg')
    expect(sniffMedia(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '), 'x')).toBe('image/webp')
    expect(sniffMedia(new TextEncoder().encode('GIF89a'), 'x')).toBe('image/gif')
    expect(sniffMedia(new TextEncoder().encode('\0\0\0\x1cftypavif'), 'x')).toBe('image/avif')
    expect(sniffMedia(BLEND, 'x')).toBe('application/x-blender')
    // Compressed, a .blend file only shows it's compressed: its name says the rest.
    const zstd = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0])
    expect(sniffMedia(zstd, 'scene.blend')).toBe('application/x-blender')
    expect(sniffMedia(zstd, 'scene.zst')).toBeUndefined()
    expect(sniffMedia(new TextEncoder().encode('<svg>'), 'x.svg')).toBeUndefined()
  })

  it('finds the frames of a compressed .blend file from its seek table', () => {
    // Two frames of 5 and 3 bytes, then the seek table's skippable frame: entries, frame count, descriptor, magic.
    const table = [5, 100, 3, 50].flatMap((n) => [n & 0xff, (n >> 8) & 0xff, 0, 0])
    const bytes = new Uint8Array([...new Array(8).fill(9), 0x5e, 0x2a, 0x4d, 0x18, 25, 0, 0, 0, ...table, 2, 0, 0, 0, 0, 0xb1, 0xea, 0x92, 0x8f])
    expect(zstdFrames(bytes)).toEqual([
      { start: 0, length: 5 },
      { start: 5, length: 3 }
    ])
    expect(zstdFrames(PNG)).toEqual([{ start: 0, length: PNG.length }])
  })
})
