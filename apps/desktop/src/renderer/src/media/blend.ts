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

/** Triangles fanned across each face from its corners, leaving out any that point past the vertices (a damaged file). */
function fan(faces: number, start: (f: number) => number, size: (f: number) => number, corners: Int32Array | undefined, vertices: number): Uint32Array | undefined {
  if (!corners) return undefined
  let total = 0
  for (let f = 0; f < faces; f++) total += Math.max(0, size(f) - 2)
  const out = new Uint32Array(total * 3)
  let n = 0
  for (let f = 0; f < faces; f++) {
    const first = start(f)
    const count = size(f)
    if (first < 0 || first + count > corners.length) continue
    const a = corners[first]!
    for (let k = 1; k + 1 < count; k++) {
      const b = corners[first + k]!
      const c = corners[first + k + 1]!
      if (a >= 0 && b >= 0 && c >= 0 && a < vertices && b < vertices && c < vertices) out.set([a, b, c], n++ * 3)
    }
  }
  return n * 3 === out.length ? out : out.slice(0, n * 3)
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
    const me = recordOf(this.file, ob.follow('data'))
    if (!me) return undefined
    const vertices = me.number('totvert', 'verts_num') ?? 0
    const positions = this.positions(me, vertices)
    const indices = this.faces(me, vertices)
    if (!positions || !indices || indices.length === 0) return undefined
    if (this.triangles + indices.length / 3 > MAX_TRIANGLES) {
      this.cut = true
      return undefined
    }
    this.triangles += indices.length / 3
    // Into the world, in place.
    const m = this.world(ob).elements
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]!
      const y = positions[i + 1]!
      const z = positions[i + 2]!
      positions[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
      positions[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
      positions[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
    }
    return { name: ob.inner('id')?.text('name').slice(2) ?? 'Object', positions, indices, color: this.color(ob, me) }
  }

  /** x, y, z per vertex, before the object's transform: in MVert structs (before 3.5), or a 'position' attribute. */
  private positions(me: StructView, count: number): Float32Array | undefined {
    const { file } = this
    const mvert = me.follow('mvert') ?? this.layer(me, 'vdata', (_, s) => s === 'MVert')
    const column = mvert
      ? file.column(mvert, count, 3, 'float', { struct: file.struct('MVert'), field: 'co' })
      : file.column(this.layer(me, 'vdata', (l) => l === 'position') ?? this.attribute(me, 'position'), count, 3, 'float')
    return column as Float32Array | undefined
  }

  /** Triangles (a fan across each face), as vertex indices. */
  private faces(me: StructView, vertices: number): Uint32Array | undefined {
    const { file } = this
    const faceCount = me.number('totpoly', 'faces_num') ?? 0
    const cornerCount = me.number('totloop', 'corners_num') ?? 0
    const corners = () => this.corners(me, cornerCount)
    // Blender 3.6 on: where each face's corners start, and one past the last.
    const offsets = file.column(me.follow('poly_offset_indices', 'face_offset_indices'), faceCount + 1, 1, 'int')
    if (offsets) return fan(faceCount, (f) => offsets[f]!, (f) => offsets[f + 1]! - offsets[f]!, corners(), vertices)
    // Before: an MPoly per face, its first corner and how many (faces needn't be in the order of their corners).
    const mpoly = me.follow('mpoly') ?? this.layer(me, 'pdata', (_, s) => s === 'MPoly')
    if (mpoly) {
      const struct = file.struct('MPoly')
      const starts = file.column(mpoly, faceCount, 1, 'int', { struct, field: 'loopstart' })
      const sizes = file.column(mpoly, faceCount, 1, 'int', { struct, field: 'totloop' })
      return starts && sizes ? fan(faceCount, (f) => starts[f]!, (f) => sizes[f]!, corners(), vertices) : undefined
    }
    return this.legacyFaces(me, vertices)
  }

  /** The vertex at each corner of every face: a '.corner_vert' attribute (3.6 on), or MLoop structs. */
  private corners(me: StructView, count: number): Int32Array | undefined {
    const { file } = this
    const named = this.layer(me, 'ldata', (l) => l === '.corner_vert') ?? this.attribute(me, '.corner_vert')
    if (named) return file.column(named, count, 1, 'int') as Int32Array | undefined
    const mloop = me.follow('mloop') ?? this.layer(me, 'ldata', (_, s) => s === 'MLoop')
    return file.column(mloop, count, 1, 'int', { struct: file.struct('MLoop'), field: 'v' }) as Int32Array | undefined
  }

  /** Before Blender 2.63 faces were triangles and quads (MFace; v4 is 0 for a triangle). */
  private legacyFaces(me: StructView, vertices: number): Uint32Array | undefined {
    const { file } = this
    const mface = me.follow('mface')
    const struct = file.struct('MFace')
    const count = me.number('totface') ?? 0
    const [v1, v2, v3, v4] = ['v1', 'v2', 'v3', 'v4'].map((field) => file.column(mface, count, 1, 'int', { struct, field }))
    if (!v1 || !v2 || !v3 || !v4) return undefined
    const corners = new Int32Array(count * 4)
    for (let f = 0; f < count; f++) corners.set([v1[f]!, v2[f]!, v3[f]!, v4[f]!], f * 4)
    return fan(count, (f) => f * 4, (f) => (v4[f] === 0 ? 3 : 4), corners, vertices)
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

/** Only the thumbnail: the file's blocks are skimmed, its meshes not read. */
export const blendThumbnail = (bytes: Uint8Array): BlendThumbnail | null => thumbnailOf(new BlendFile(bytes))
