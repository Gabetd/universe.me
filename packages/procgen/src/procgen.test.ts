import { CUBE_FACES, CommandBus, DEFAULT_WORLD_SETTINGS, MemoryStore, TERRAIN_RES, createRootUniverse, emptyLayer } from '@universe/core'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  TerrainModel,
  autoBiome,
  BIOME,
  BIOMES,
  buildGroundChunk,
  cellCenter,
  chunkBounds,
  chunkOf,
  dirToFace,
  dirToLatLon,
  faceToDir,
  generateBase,
  kthSmallest,
  latLonToDir,
  modelSampler,
  renderEquirect,
  renderFaceTexture,
  rng,
  sampleBaseGrid,
  toGrid,
  worldPalette,
  type BaseTerrain
} from './index'

let base: BaseTerrain
beforeAll(() => {
  base = generateBase(12345, DEFAULT_WORLD_SETTINGS.terrain)
})

describe('cube-sphere', () => {
  it('round-trips face coordinates on every face', () => {
    for (let face = 0; face < 6; face++) {
      for (const [s, t] of [[0, 0], [0.5, -0.3], [-0.9, 0.9]] as const) {
        const d = faceToDir(face, s, t)
        expect(Math.hypot(...d)).toBeCloseTo(1, 10)
        const back = dirToFace(...d)
        expect(back.face).toBe(face)
        expect(back.s).toBeCloseTo(s, 10)
        expect(back.t).toBeCloseTo(t, 10)
      }
    }
  })

  it('maps cell centers back to their own cell', () => {
    const d = faceToDir(3, cellCenter(17), cellCenter(200))
    const { s, t } = dirToFace(...d)
    expect(Math.round(toGrid(s))).toBe(17)
    expect(Math.round(toGrid(t))).toBe(200)
  })

  it('round-trips latitude and longitude', () => {
    const { lat, lon } = dirToLatLon(...latLonToDir(-33.5, 151.2))
    expect(lat).toBeCloseTo(-33.5, 10)
    expect(lon).toBeCloseTo(151.2, 10)
    expect(latLonToDir(90, 0)[1]).toBeCloseTo(1, 10)
  })
})

describe('generateBase', () => {
  it('is deterministic per seed', () => {
    const again = generateBase(12345, DEFAULT_WORLD_SETTINGS.terrain)
    expect(again.height[2]!.subarray(0, 100)).toEqual(base.height[2]!.subarray(0, 100))
    const other = generateBase(999, DEFAULT_WORLD_SETTINGS.terrain)
    expect(other.height[2]!.subarray(0, 100)).not.toEqual(base.height[2]!.subarray(0, 100))
  })

  it('makes both oceans and land, with mountains', () => {
    let land = 0
    let max = -Infinity
    for (const face of base.height) {
      for (const h of face) {
        if (h > 0) land++
        max = Math.max(max, h)
      }
    }
    const fraction = land / (6 * TERRAIN_RES * TERRAIN_RES)
    expect(fraction).toBeGreaterThan(0.15)
    expect(fraction).toBeLessThan(0.7)
    expect(max).toBeGreaterThan(2000)
  })
})

describe('biomes', () => {
  it('has unique ids matching their index', () => {
    BIOMES.forEach((b, i) => expect(b.id).toBe(i))
  })

  it('follows the rough climate rules', () => {
    expect(autoBiome(85, 100, 0.5)).toBe(BIOME.ice)
    expect(autoBiome(0, 6000, 0.5)).toBe(BIOME.ice)
    expect(autoBiome(0, 3500, 0.5)).toBe(BIOME.rock)
    expect(autoBiome(2, 300, 0.9)).toBe(BIOME.rainforest)
    expect(autoBiome(25, 300, 0.05)).toBe(BIOME.desert)
  })
})

describe('TerrainModel brushes', () => {
  const center = latLonToDir(10, 20)

  it('raises terrain within the radius only, strongest at the center', () => {
    const model = new TerrainModel(DEFAULT_WORLD_SETTINGS, base)
    const before = model.sampleHeight(...center)
    const farDir = latLonToDir(-40, -100)
    const far = model.sampleHeight(...farDir)
    model.beginStroke({ tool: 'raise', radiusKm: 400, strength: 1 }, center)
    model.dab(center)
    expect(model.sampleHeight(...center) - before).toBeGreaterThan(100)
    expect(model.sampleHeight(...farDir)).toBe(far)
  })

  it('flatten pulls heights toward the starting height', () => {
    const model = new TerrainModel(DEFAULT_WORLD_SETTINGS, base)
    const near = latLonToDir(11, 21)
    const target = model.sampleHeight(...center)
    const gap = Math.abs(model.sampleHeight(...near) - target)
    model.beginStroke({ tool: 'flatten', radiusKm: 500, strength: 1 }, center)
    for (let i = 0; i < 10; i++) model.dab(center)
    expect(Math.abs(model.sampleHeight(...near) - target)).toBeLessThan(gap + 1)
  })

  it('paints biomes and erases them back to auto', () => {
    const model = new TerrainModel(DEFAULT_WORLD_SETTINGS, base)
    const { face, cell } = model.cellAt(...center)
    model.beginStroke({ tool: 'paint', radiusKm: 200, strength: 1, biome: BIOME.swamp }, center)
    model.dab(center)
    model.endStroke('w')
    expect(model.biome(face, cell)).toBe(BIOME.swamp)
    model.beginStroke({ tool: 'erase', radiusKm: 200, strength: 1 }, center)
    model.dab(center)
    expect(model.biomeEdits[face]![cell]).toBe(0)
  })

  it('a stroke becomes a terrain.patch that reproduces it in the project', () => {
    const store = new MemoryStore()
    const bus = new CommandBus(store)
    let parent = createRootUniverse(store, 'U').id
    for (const kind of ['galaxy_cluster', 'galaxy', 'star_system', 'body', 'world']) {
      parent = bus.execute({ type: 'node.create', payload: { parentId: parent, kind } }).targetId!
    }
    const model = new TerrainModel(DEFAULT_WORLD_SETTINGS, base)
    model.beginStroke({ tool: 'raise', radiusKm: 600, strength: 0.7 }, center)
    model.dab(center)
    model.dab(latLonToDir(12, 24))
    const payload = model.endStroke(parent)!
    expect(model.isStroking).toBe(false)
    bus.execute({ type: 'terrain.patch', payload })

    const reloaded = new TerrainModel(DEFAULT_WORLD_SETTINGS, base, {
      height: Array.from({ length: CUBE_FACES }, (_, f) => store.worlds.getLayer(parent, 'height', f) ?? emptyLayer('height'))
    })
    for (let f = 0; f < CUBE_FACES; f++) expect(reloaded.heightEdits[f]).toEqual(model.heightEdits[f])
  })

  it('renders an equirectangular map', () => {
    const model = new TerrainModel(DEFAULT_WORLD_SETTINGS, base)
    const out = new Uint8ClampedArray(256 * 128 * 4)
    renderEquirect(model, out, 256, 128)
    expect(out[3]).toBe(255)
    expect(new Set(out.filter((_, i) => i % 4 === 0)).size).toBeGreaterThan(20)
  })
})

describe('kthSmallest', () => {
  it('finds what sorting would put at k', () => {
    const r = rng(3)
    for (const n of [1, 2, 7, 100, 1001]) {
      // Few distinct values, so there are plenty of ties.
      const a = Float32Array.from({ length: n }, () => Math.round(r() * 20) - 10 + (r() < 0.5 ? r() : 0))
      const sorted = a.slice().sort()
      for (const k of [0, n - 1, n >> 1, Math.floor(n * 0.7), Math.floor(r() * n)]) expect(kthSmallest(a.slice(), k)).toBe(sorted[k])
    }
  })
})

/** FNV-1a over the bytes of some arrays, to pin outputs. */
function hash(views: ArrayBufferView[]): string {
  let h = 0x811c9dc5
  for (const v of views) {
    const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

describe('outputs stay the same', () => {
  // Hashes of what the generator, the globe, the map and the ground made before they were optimized: a speed-up must not change a byte.
  it('for the terrain, its colours, the map and a ground chunk', () => {
    expect(hash([...base.height, ...base.moisture])).toBe('f67e7407')
    const model = new TerrainModel(DEFAULT_WORLD_SETTINGS, base)
    const faces = () =>
      Array.from({ length: CUBE_FACES }, (_, f) => {
        const pixels = new Uint8Array(TERRAIN_RES * TERRAIN_RES * 4)
        renderFaceTexture(model, f, pixels)
        return pixels
      })
    expect(hash(faces())).toBe('1612eb31')

    const settings = { ...DEFAULT_WORLD_SETTINGS, seaLevel: 150, terrain: { ...DEFAULT_WORLD_SETTINGS.terrain, vegetationColor: '#7a3fa0', waterColor: '#3fa08a', temperature: 5, aridity: 0.7, beaches: 1 } }
    model.settings = settings
    model.setSky({ offsetC: -3, gradient: 1.2 })
    model.beginStroke({ tool: 'raise', radiusKm: 800, strength: 1 }, latLonToDir(10, 20))
    model.dab(latLonToDir(10, 20))
    model.endStroke('w')
    model.beginStroke({ tool: 'paint', radiusKm: 500, strength: 1, biome: BIOME.swamp }, latLonToDir(-20, 100))
    model.dab(latLonToDir(-20, 100))
    model.endStroke('w')
    expect(hash(faces())).toBe('b24ed931')

    const map = new Uint8ClampedArray(512 * 256 * 4)
    renderEquirect(model, map, 512, 256)
    expect(hash([map])).toBe('a706c823')

    const R = settings.radiusKm
    const id = chunkOf({ lat: 10, lon: 20 }, R)
    const b = chunkBounds(id, R)
    const chunk = buildGroundChunk({
      id,
      frame: { origin: { lat: b.lat0, lon: b.lon0 }, radiusKm: R },
      seed: 12345,
      grid: sampleBaseGrid(modelSampler(model), b),
      biomeColors: worldPalette(settings.terrain).biomes,
      seabedColor: [40, 60, 80]
    })
    expect(hash([chunk.positions, chunk.colors, chunk.indices, ...Object.values(chunk.plants)])).toBe('fdc894e4')
  })
})
