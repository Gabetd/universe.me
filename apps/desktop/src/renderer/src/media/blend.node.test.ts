import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { blendCompression, sniffMedia, zstdFrames } from '@universe/core'
import { readBlend } from './blend'

// Saved by Blender's own Python module (bpy) from one script: a box, a cone turned and stretched, and a moon parented to the box; each its own colour.
const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)))
const inflate = (packed: Uint8Array) => new Uint8Array(Buffer.concat(zstdFrames(packed).map((f) => zstdDecompressSync(packed.subarray(f.start, f.start + f.length)))))
const EXPECTED = [
  { name: 'Box', verts: 8, triangles: 12, min: [-1, -1, 0], max: [1, 1, 2], color: [0.8, 0.1, 0.1] },
  { name: 'Hat', verts: 9, triangles: 14, min: [2, -1, -1.5], max: [4, 1, 2.5], color: [0.1, 0.2, 0.9] },
  { name: 'Moon', verts: 12, triangles: 20, min: [-0.4472, 1.5747, 1.5], max: [0.4472, 2.4253, 2.5], color: [0.9, 0.9, 0.2] }
]

describe('reading a .blend file', () => {
  for (const [file, version] of [
    ['blender-4.2.blend', '4.2'],
    ['blender-5.2.blend', '5.2']
  ] as const) {
    it(`finds the meshes of a scene saved by Blender ${version}, where they stand`, () => {
      const packed = fixture(file)
      expect(blendCompression(packed)).toBe('zstd')
      expect(sniffMedia(packed, file)).toBe('application/x-blender')
      const scene = readBlend(inflate(packed))
      expect(scene.version).toBe(version)
      expect(scene.others).toBe(1)
      expect(scene.cut).toBe(false)
      const meshes = [...scene.meshes].sort((a, b) => a.name.localeCompare(b.name))
      expect(meshes.map((m) => m.name)).toEqual(EXPECTED.map((e) => e.name))
      meshes.forEach((m, i) => {
        const want = EXPECTED[i]!
        expect(m.positions.length / 3).toBe(want.verts)
        expect(m.indices.length / 3).toBe(want.triangles)
        expect(Math.max(...m.indices)).toBeLessThan(want.verts)
        for (let axis = 0; axis < 3; axis++) {
          const values = Array.from({ length: want.verts }, (_, v) => m.positions[v * 3 + axis]!)
          expect(Math.min(...values)).toBeCloseTo(want.min[axis]!, 3)
          expect(Math.max(...values)).toBeCloseTo(want.max[axis]!, 3)
        }
        m.color.forEach((c, k) => expect(c).toBeCloseTo(want.color[k]!, 3))
      })
    })
  }

  it('keeps the thumbnail Blender saved, top row first', () => {
    const scene = readBlend(inflate(fixture('blender-5.2.blend')))
    expect(scene.thumbnail).not.toBeNull()
    const { width, height, rgba } = scene.thumbnail!
    expect(rgba.length).toBe(width * height * 4)
  })

  it('reads a picture from the TEST block bottom row up', () => {
    // A 2×2 thumbnail, red on the bottom row, blue on the top, in a file with an empty description.
    const head = new TextEncoder().encode('BLENDER-v402')
    const block = (code: string, data: Uint8Array) => {
      const h = new Uint8Array(24)
      h.set(new TextEncoder().encode(code))
      new DataView(h.buffer).setInt32(4, data.length, true)
      return [h, data]
    }
    const thumb = new Uint8Array(8 + 16)
    new DataView(thumb.buffer).setInt32(0, 2, true)
    new DataView(thumb.buffer).setInt32(4, 2, true)
    thumb.set([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255], 8)
    const dna = new Uint8Array(4 * 9 + 4)
    dna.set(new TextEncoder().encode('SDNANAME'), 0)
    dna.set(new TextEncoder().encode('TYPE'), 12)
    dna.set(new TextEncoder().encode('TLEN'), 20)
    dna.set(new TextEncoder().encode('STRC'), 24)
    const parts = [head, ...block('TEST', thumb), ...block('DNA1', dna), ...block('ENDB', new Uint8Array(0))]
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    parts.reduce((at, p) => (bytes.set(p, at), at + p.length), 0)
    const scene = readBlend(bytes)
    expect(scene.thumbnail?.width).toBe(2)
    expect([...scene.thumbnail!.rgba.subarray(0, 4)]).toEqual([0, 0, 255, 255])
    expect([...scene.thumbnail!.rgba.subarray(8, 12)]).toEqual([255, 0, 0, 255])
    expect(scene.meshes).toEqual([])
  })

  it('says so when it isn’t a Blender file', () => {
    expect(() => readBlend(new TextEncoder().encode('not a blend file at all'))).toThrow('isn’t a Blender file')
  })
})
