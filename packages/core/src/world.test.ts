import { beforeEach, describe, expect, it } from 'vitest'
import {
  CommandBus,
  DEFAULT_WORLD_SETTINGS,
  MemoryStore,
  TERRAIN_RES,
  asBytes,
  base64ToBytes,
  bytesToBase64,
  createRootUniverse,
  readRect,
  writeRect
} from './index'

let store: MemoryStore
let bus: CommandBus
let worldId: string
let planetId: string

beforeEach(() => {
  store = new MemoryStore()
  let n = 0
  bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 3 } })
  const root = createRootUniverse(store, 'U').id
  const make = (parentId: string, kind: string) => bus.execute({ type: 'node.create', payload: { parentId, kind } }).targetId!
  planetId = make(make(make(make(root, 'galaxy_cluster'), 'galaxy'), 'star_system'), 'body')
  worldId = make(planetId, 'world')
})

const heights = (values: number[]) => bytesToBase64(asBytes(new Int16Array(values)))
const faceHeights = (face = 0) => new Int16Array(store.worlds.getLayer(worldId, 'height', face)!.buffer)

describe('encoding and rects', () => {
  it('round-trips base64', () => {
    const bytes = new Uint8Array(70000).map((_, i) => i % 251)
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })

  it('reads back what it writes', () => {
    const face = new Uint8Array(TERRAIN_RES * TERRAIN_RES * 2)
    const rect = { x: 250, y: 3, w: 6, h: 2 }
    const data = new Uint8Array(24).map((_, i) => i + 1)
    writeRect(face, rect, data, 2)
    expect(readRect(face, rect, 2)).toEqual(data)
    expect(face[(3 * TERRAIN_RES + 250) * 2]).toBe(1)
  })
})

describe('world.update', () => {
  it('merges settings and undoes to the previous values', () => {
    bus.execute({ type: 'world.update', payload: { id: worldId, patch: { seaLevel: 120, terrain: { roughness: 0.9 } } } })
    expect(store.worlds.getSettings(worldId)).toEqual({
      ...DEFAULT_WORLD_SETTINGS,
      seaLevel: 120,
      terrain: { ...DEFAULT_WORLD_SETTINGS.terrain, roughness: 0.9 }
    })
    bus.undo()
    expect(store.worlds.getSettings(worldId)).toEqual(DEFAULT_WORLD_SETTINGS)
  })

  it('only applies to worlds', () => {
    expect(() => bus.execute({ type: 'world.update', payload: { id: planetId, patch: { seaLevel: 1 } } })).toThrow(/not a world/)
  })

  it('rejects out-of-range values', () => {
    expect(() => bus.execute({ type: 'world.update', payload: { id: worldId, patch: { radiusKm: -5 } } })).toThrow()
  })
})

describe('terrain.patch', () => {
  it('writes cells, bumps the revision, and undoes overlapping patches', () => {
    bus.execute({
      type: 'terrain.patch',
      payload: {
        worldId,
        layer: 'height',
        patches: [
          { face: 0, x: 0, y: 0, w: 2, h: 1, data: heights([100, 200]) },
          { face: 0, x: 1, y: 0, w: 2, h: 1, data: heights([300, 400]) }
        ]
      }
    })
    expect([...faceHeights().subarray(0, 3)]).toEqual([100, 300, 400])
    expect(store.worlds.terrainRevision(worldId)).toBe(1)
    bus.undo()
    expect([...faceHeights().subarray(0, 3)]).toEqual([0, 0, 0])
    bus.redo()
    expect([...faceHeights().subarray(0, 3)]).toEqual([100, 300, 400])
  })

  it('rejects patches that are out of bounds or the wrong size', () => {
    const patch = (p: object) => bus.execute({ type: 'terrain.patch', payload: { worldId, layer: 'height', patches: [p] } })
    expect(() => patch({ face: 0, x: 255, y: 0, w: 2, h: 1, data: heights([1, 2]) })).toThrow(/past the grid/)
    expect(() => patch({ face: 0, x: 0, y: 0, w: 2, h: 1, data: heights([1]) })).toThrow(/wrong size/)
  })

  it('reset clears a layer and undo restores it', () => {
    bus.execute({ type: 'terrain.patch', payload: { worldId, layer: 'biome', patches: [{ face: 4, x: 9, y: 9, w: 1, h: 1, data: bytesToBase64(new Uint8Array([7])) }] } })
    bus.execute({ type: 'terrain.reset', payload: { worldId, layer: 'biome' } })
    expect(store.worlds.getLayer(worldId, 'biome', 4)!.some((v) => v !== 0)).toBe(false)
    bus.undo()
    expect(store.worlds.getLayer(worldId, 'biome', 4)![9 * TERRAIN_RES + 9]).toBe(7)
  })
})

describe('regions', () => {
  const triangle = [
    { lat: 10, lon: 10 },
    { lat: 20, lon: 15 },
    { lat: 10, lon: 20 }
  ]

  it('creates, updates, deletes, and restores', () => {
    const id = bus.execute({ type: 'region.create', payload: { worldId, points: triangle, name: 'Highlands' } }).targetId!
    expect(store.regions.get(id)).toMatchObject({ name: 'Highlands', worldId, color: expect.stringMatching(/^#/) })

    bus.execute({ type: 'region.update', payload: { id, patch: { name: 'Lowlands', color: '#123456' } } })
    bus.undo()
    expect(store.regions.get(id)).toMatchObject({ name: 'Highlands' })

    bus.execute({ type: 'region.delete', payload: { id } })
    expect(store.regions.all()).toHaveLength(0)
    bus.undo()
    expect(store.regions.all()).toHaveLength(1)
  })

  it('targets the region and marks its world as changed', () => {
    store.nodes.update({ ...store.nodes.get(worldId)!, updatedAt: 'before' })
    const result = bus.execute({ type: 'region.create', payload: { worldId, points: triangle } })
    expect(result.target).toEqual({ kind: 'region', id: result.targetId })
    expect(store.nodes.get(worldId)!.updatedAt).not.toBe('before')
    expect(bus.undo()!.target).toEqual({ kind: 'node', id: worldId })
  })

  it('needs at least three points on a world', () => {
    expect(() => bus.execute({ type: 'region.create', payload: { worldId, points: triangle.slice(0, 2) } })).toThrow()
    expect(() => bus.execute({ type: 'region.create', payload: { worldId: planetId, points: triangle } })).toThrow(/not a world/)
  })
})
