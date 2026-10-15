import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { BlendFile, recordOf, recordsOf, type Block, type StructView } from './blendFile'

/**
 * What a .blend file shows: the meshes of its scene where they stand (each
 * object's own copy, in world space, Blender's Z up), each in its first
 * material's colour, and the thumbnail Blender saved with it. Modifiers,
 * curves, text and the like aren't drawn: the meshes are what they were
 * modelled as.
 */
export interface BlendMesh {
  name: string
  /** x, y, z per vertex, in world space. */
  positions: Float32Array
  /** Three vertices per triangle. */
  indices: Uint32Array
  /** Linear RGB, 0–1. */
  color: [number, number, number]
}

export interface BlendThumbnail {
  width: number
  height: number
  /** RGBA, top row first. */
  rgba: Uint8ClampedArray
}

export interface BlendScene {
  /** Blender's version that saved it, like '4.2'. */
  version: string
  meshes: BlendMesh[]
  /** Objects in the scene that aren't meshes (cameras, lights, curves…), not drawn. */
  others: number
  /** True when it had more triangles than are drawn. */
  cut: boolean
  thumbnail: BlendThumbnail | null
}

/** Enough to see a scene by, and no more than a viewer copes with. */
export const MAX_TRIANGLES = 3_000_000

const OB_MESH = 1
const GREY: [number, number, number] = [0.7, 0.7, 0.7]

/** Reads a .blend file's scene (uncompressed bytes: see `blendCompression` in @universe/core). Throws if it isn't one, or is damaged. */
export function readBlend(bytes: Uint8Array): BlendScene {
  const file = new BlendFile(bytes)
  const scene = new SceneReader(file)
  return { version: file.version, ...scene.read(), thumbnail: thumbnailOf(file) }
}

/** The picture Blender keeps at the front of the file ('TEST' block): width, height, then RGBA from the bottom row up. */
function thumbnailOf(file: BlendFile): BlendThumbnail | null {
  const block = file.blocks.find((b) => b.code === 'TEST')
  if (!block || block.length < 8) return null
  const width = file.view.getInt32(block.offset, file.little)
  const height = file.view.getInt32(block.offset + 4, file.little)
  const row = width * 4
  if (width <= 0 || height <= 0 || 8 + row * height > block.length) return null
  const rgba = new Uint8ClampedArray(row * height)
  for (let y = 0; y < height; y++) rgba.set(file.bytes.subarray(block.offset + 8 + (height - 1 - y) * row, block.offset + 8 + (height - y) * row), y * row)
  return { width, height, rgba }
}

/** Reads `count` 32-bit numbers from a raw block. */
function numbersIn(file: BlendFile, block: Block | undefined, type: 'float' | 'int', count: number): number[] | undefined {
  if (!block || block.length < count * 4) return undefined
  const out = new Array<number>(count)
  for (let i = 0; i < count; i++) out[i] = file.number(type, block.offset + i * 4)
  return out
}

class SceneReader {
  private triangles = 0
  private cut = false
  private readonly worlds = new Map<string, Matrix4>()

  constructor(private readonly file: BlendFile) {}

  read(): { meshes: BlendMesh[]; others: number; cut: boolean } {
    const objects = this.sceneObjects()
    const meshes: BlendMesh[] = []
    let others = 0
    for (const ob of objects) {
      if (ob.number('type') !== OB_MESH) {
        others++
        continue
      }
      const mesh = this.mesh(ob)
      if (mesh) meshes.push(mesh)
    }
    return { meshes, others, cut: this.cut }
  }

  /** The objects of the scene the file was saved on, through its collections (2.8 on) or its bases (before); every object if there's no scene. */
  private sceneObjects(): StructView[] {
    const { file } = this
    const glob = recordOf(file, file.blocks.find((b) => b.code === 'GLOB'))
    const sceneBlock = glob?.follow('curscene') ?? file.blocks.find((b) => b.code === 'SC\0\0')
    const scene = recordOf(file, sceneBlock)
    const found = new Map<number, StructView>()
    const add = (block: Block | undefined) => {
      const ob = recordOf(file, block)
      if (ob && block!.code === 'OB\0\0') found.set(block!.offset, ob)
    }
    if (scene?.has('master_collection')) {
      const seen = new Set<number>()
      const walk = (collection: StructView | undefined) => {
        if (!collection || seen.has(collection.offset)) return
        seen.add(collection.offset)
        for (const item of this.list(collection, 'gobject')) add(item.follow('ob'))
        for (const child of this.list(collection, 'children')) walk(recordOf(file, child.follow('collection')))
      }
      walk(recordOf(file, scene.follow('master_collection')))
    } else if (scene) {
      for (const base of this.list(scene, 'base')) add(base.follow('object'))
    }
    if (found.size === 0) for (const b of file.blocks) if (b.code === 'OB\0\0') add(b)
    return [...found.values()]
  }

  /** The items of a ListBase field. */
  private list(owner: StructView, field: string): StructView[] {
    const out: StructView[] = []
    const seen = new Set<Block>()
    let block = owner.inner(field)?.follow('first')
    while (block && !seen.has(block) && out.length < 100_000) {
      seen.add(block)
      const item = recordOf(this.file, block)
      if (!item) break
      out.push(item)
      block = item.follow('next')
    }
    return out
  }

  /** An object's place in the world: saved (before 4.1), or worked out from its parents, location, rotation and scale. */
  private world(ob: StructView, depth = 0): Matrix4 {
    const known = this.worlds.get(String(ob.offset))
    if (known) return known
    const saved = ob.numbers('obmat') ?? ob.numbers('object_to_world')
    let world: Matrix4
    if (saved?.length === 16 && saved.some((v) => v !== 0)) world = new Matrix4().fromArray(saved)
    else {
      const local = localMatrix(ob)
      const parent = recordOf(this.file, ob.follow('parent'))
      world =
        parent && depth < 64
          ? this.world(parent, depth + 1)
              .clone()
              .multiply(new Matrix4().fromArray(ob.numbers('parentinv') ?? IDENTITY))
              .multiply(local)
          : local
    }
    this.worlds.set(String(ob.offset), world)
    return world
  }

  private mesh(ob: StructView): BlendMesh | undefined {
    const { file } = this
    const me = recordOf(file, ob.follow('data'))
    if (!me) return undefined
    const vertices = me.number('totvert', 'verts_num') ?? 0
    const local = this.positions(me, vertices)
    const indices = this.faces(me, vertices)
    if (!local || !indices || indices.length === 0) return undefined
    if (this.triangles + indices.length / 3 > MAX_TRIANGLES) {
      this.cut = true
      return undefined
    }
    this.triangles += indices.length / 3
    const world = this.world(ob)
    const positions = new Float32Array(vertices * 3)
    const v = new Vector3()
    for (let i = 0; i < vertices; i++) {
      v.set(local[i * 3]!, local[i * 3 + 1]!, local[i * 3 + 2]!).applyMatrix4(world)
      positions.set([v.x, v.y, v.z], i * 3)
    }
    return { name: ob.inner('id')?.text('name').slice(2) ?? 'Object', positions, indices, color: this.color(ob, me) }
  }

  /** x, y, z per vertex, before the object's transform. */
  private positions(me: StructView, count: number): number[] | undefined {
    const { file } = this
    const mvert = me.follow('mvert') ?? this.layer(me, 'vdata', (l, s) => s === 'MVert')
    if (mvert) {
      const struct = file.struct('MVert')!
      return recordsOf(file, mvert, struct)
        .slice(0, count)
        .flatMap((r) => r.numbers('co') ?? [0, 0, 0])
    }
    return numbersIn(file, this.layer(me, 'vdata', (l) => l === 'position') ?? this.attribute(me, 'position'), 'float', count * 3)
  }

  /** Triangles (a fan across each face), as vertex indices. */
  private faces(me: StructView, vertices: number): Uint32Array | undefined {
    const { file } = this
    const faceCount = me.number('totpoly', 'faces_num') ?? 0
    const cornerCount = me.number('totloop', 'corners_num') ?? 0
    let starts: number[] | undefined
    const offsets = numbersIn(file, me.follow('poly_offset_indices', 'face_offset_indices'), 'int', faceCount + 1)
    if (offsets) starts = offsets
    else {
      const mpoly = me.follow('mpoly') ?? this.layer(me, 'pdata', (l, s) => s === 'MPoly')
      if (mpoly) {
        const polys = recordsOf(file, mpoly, file.struct('MPoly')).slice(0, faceCount)
        starts = [...polys.map((p) => p.number('loopstart') ?? 0), cornerCount]
        // Faces needn't be in order of their corners: each face's own count is what holds.
        const sizes = polys.map((p) => p.number('totloop') ?? 0)
        return this.fan(polys.map((_, i) => [starts![i]!, sizes[i]!]), this.corners(me, cornerCount), vertices)
      }
    }
    if (starts) return this.fan(starts.slice(0, -1).map((s, i) => [s, starts![i + 1]! - s]), this.corners(me, cornerCount), vertices)
    return this.legacyFaces(me, vertices)
  }

  /** The vertex at each corner of every face. */
  private corners(me: StructView, count: number): number[] | undefined {
    const { file } = this
    const named = this.layer(me, 'ldata', (l) => l === '.corner_vert') ?? this.attribute(me, '.corner_vert')
    if (named) return numbersIn(file, named, 'int', count)
    const mloop = me.follow('mloop') ?? this.layer(me, 'ldata', (l, s) => s === 'MLoop')
    return mloop
      ? recordsOf(file, mloop, file.struct('MLoop'))
          .slice(0, count)
          .map((r) => r.number('v') ?? 0)
      : undefined
  }

  private fan(faces: [start: number, size: number][], corners: number[] | undefined, vertices: number): Uint32Array | undefined {
    if (!corners) return undefined
    const out: number[] = []
    for (const [start, size] of faces) {
      if (start < 0 || start + size > corners.length) continue
      for (let k = 1; k + 1 < size; k++) {
        const a = corners[start]!
        const b = corners[start + k]!
        const c = corners[start + k + 1]!
        if (a < vertices && b < vertices && c < vertices) out.push(a, b, c)
      }
    }
    return Uint32Array.from(out)
  }

  /** Before Blender 2.63 faces were triangles and quads (MFace). */
  private legacyFaces(me: StructView, vertices: number): Uint32Array | undefined {
    const mface = me.follow('mface')
    if (!mface) return undefined
    const out: number[] = []
    for (const f of recordsOf(this.file, mface, this.file.struct('MFace'))) {
      const [a, b, c, d] = ['v1', 'v2', 'v3', 'v4'].map((k) => f.number(k) ?? 0) as [number, number, number, number]
      if (Math.max(a, b, c) >= vertices) continue
      out.push(a, b, c)
      if (d !== 0 && d < vertices) out.push(a, c, d)
    }
    return Uint32Array.from(out)
  }

  /** A CustomData layer's data block: the first whose name and data's struct pass `pick`. */
  private layer(me: StructView, data: string, pick: (name: string, struct: string | undefined) => boolean): Block | undefined {
    const custom = me.inner(data)
    const layers = custom?.follow('layers')
    if (!layers) return undefined
    for (const l of recordsOf(this.file, layers, this.file.struct('CustomDataLayer'))) {
      const block = l.follow('data')
      if (block && pick(l.text('name'), this.file.structOf(block)?.name)) return block
    }
    return undefined
  }

  /** A named attribute's array, where Blender 5 keeps them (AttributeStorage). */
  private attribute(me: StructView, name: string): Block | undefined {
    const { file } = this
    const list = me.inner('attribute_storage')?.follow('dna_attributes')
    if (!list) return undefined
    for (const a of recordsOf(file, list, file.struct('Attribute'))) {
      const label = a.follow('name')
      if (!label || file.text(label.offset, label.length) !== name) continue
      const array = recordOf(file, a.follow('data'), 'AttributeArray')
      return array?.follow('data')
    }
    return undefined
  }

  /** The first material's colour: its Principled BSDF's base colour if it uses nodes, its viewport colour if not. */
  private color(ob: StructView, me: StructView): [number, number, number] {
    const { file } = this
    const slots = me.follow('mat') ?? ob.follow('mat')
    const material = slots && recordOf(file, file.follow(slots.offset))
    if (!material) return GREY
    const nodes = material.number('use_nodes') !== 0 ? this.baseColor(material) : undefined
    if (nodes) return nodes
    const [r, g, b] = ['r', 'g', 'b'].map((k) => material.number(k) ?? 0.7) as [number, number, number]
    return [r, g, b]
  }

  private baseColor(material: StructView): [number, number, number] | undefined {
    const { file } = this
    const tree = recordOf(file, material.follow('nodetree'))
    if (!tree) return undefined
    for (const node of this.list(tree, 'nodes')) {
      if (node.text('idname') !== 'ShaderNodeBsdfPrincipled') continue
      const socket = this.list(node, 'inputs').find((s) => s.text('identifier') === 'Base Color' || s.text('name') === 'Base Color')
      const value = socket && recordOf(file, socket.follow('default_value'), 'bNodeSocketValueRGBA')?.numbers('value')
      if (value) return [value[0]!, value[1]!, value[2]!]
    }
    return undefined
  }
}

const IDENTITY = new Matrix4().toArray()

/** Blender's rotation modes: quaternion, six Euler orders, axis and angle. */
const ROT_QUAT = 0
const ROT_AXIS_ANGLE = -1
const EULER_ORDERS = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'] as const

/** Blender's Euler order ABC turns about A first: three.js names that order CBA. */
const euler = (r: number[], mode: number) => new Euler(r[0], r[1], r[2], [...(EULER_ORDERS[mode - 1] ?? 'XYZ')].reverse().join('') as Euler['order'])

function localMatrix(ob: StructView): Matrix4 {
  const v = (name: string, fallback: number[]) => ob.numbers(name) ?? fallback
  const add = (a: number[], b: number[]) => a.map((x, i) => x + (b[i] ?? 0))
  const times = (a: number[], b: number[]) => a.map((x, i) => x * (b[i] ?? 1))
  const position = new Vector3(...(add(v('loc', [0, 0, 0]), v('dloc', [0, 0, 0])) as [number, number, number]))
  const scale = new Vector3(...(times(v('size', [1, 1, 1]), v('dscale', v('dsize', [1, 1, 1]))) as [number, number, number]))
  const mode = ob.number('rotmode') ?? 1
  const quat = (q: number[]) => new Quaternion(q[1], q[2], q[3], q[0])
  const axisAngle = (axis: number[], angle: number) => new Quaternion().setFromAxisAngle(new Vector3(...(axis as [number, number, number])).normalize(), angle)
  let rotation: Quaternion
  if (mode === ROT_QUAT) rotation = quat(v('dquat', [1, 0, 0, 0])).multiply(quat(v('quat', [1, 0, 0, 0])))
  else if (mode === ROT_AXIS_ANGLE) {
    const axis = v('rotAxis', [0, 1, 0])
    rotation = axisAngle(v('drotAxis', [0, 1, 0]), ob.number('drotAngle') ?? 0).multiply(axisAngle(axis.some((x) => x !== 0) ? axis : [0, 1, 0], ob.number('rotAngle') ?? 0))
  } else rotation = new Quaternion().setFromEuler(euler(v('drot', [0, 0, 0]), mode)).multiply(new Quaternion().setFromEuler(euler(v('rot', [0, 0, 0]), mode)))
  return new Matrix4().compose(position, rotation, scale)
}
