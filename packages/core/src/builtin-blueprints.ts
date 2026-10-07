import { MATERIAL_INFO, type Blueprint, type BlueprintPart, type Material, type Shape } from './structures'

/**
 * The blueprints every project starts with, generated from code: castles,
 * camps, slums, villages, a vast walled city and more. Variation (house
 * sizes, roof colours, shack materials) comes from a fixed seed per
 * blueprint, so they are the same in every project. Units are metres, y is
 * up, and every part's `at` is the centre of its base.
 */

type V3 = [number, number, number]

/** A small seeded random generator (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DEG = 180 / Math.PI

/** (x, z) turned by `deg` about the vertical, the way a part's rotation turns it. */
function turn(x: number, z: number, deg: number): [number, number] {
  const a = deg / DEG
  return [x * Math.cos(a) + z * Math.sin(a), -x * Math.sin(a) + z * Math.cos(a)]
}

const ROOF_COLORS = ['#7a3b2a', '#8c4a32', '#5b3a2a', '#6e5643', '#9a5b3c', '#4d4a52']
const PLASTER_COLORS = ['#d9cfb8', '#cbbd9e', '#e4dcc8', '#b9a888', '#d2c3a4']

/** Collects parts, with helpers for the pieces buildings are made of. */
class Kit {
  readonly parts: BlueprintPart[] = []
  constructor(readonly random: () => number = seeded(1)) {}

  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.random() * list.length)]!
  }
  between(lo: number, hi: number): number {
    return lo + this.random() * (hi - lo)
  }

  add(shape: Shape, material: Material, size: V3, at: V3 = [0, 0, 0], rotation = 0, color: string = MATERIAL_INFO[material].color): this {
    // Centimetres and tenths of a degree are plenty, and keep the numbers readable in the builder.
    const cm = (v: number) => Math.round(v * 100) / 100
    this.parts.push({ shape, material, color, size: size.map(cm) as V3, at: at.map(cm) as V3, rotation: Math.round(rotation * 10) / 10 })
    return this
  }

  /** A house: walls and a gable roof whose ridge runs along its depth; optionally a chimney. */
  house(x: number, z: number, w: number, d: number, h: number, rotation = 0, opts: { wall?: Material; roof?: Material; wallColor?: string; roofColor?: string; chimney?: boolean } = {}): this {
    const wall = opts.wall ?? 'wood'
    const roof = opts.roof ?? 'wood'
    this.add('box', wall, [w, h, d], [x, 0, z], rotation, opts.wallColor ?? this.pick(PLASTER_COLORS))
    this.add('wedge', roof, [w * 1.12, Math.max(2, w * 0.45), d * 1.08], [x, h, z], rotation, opts.roofColor ?? this.pick(ROOF_COLORS))
    if (opts.chimney) {
      const [cx, cz] = turn(w * 0.25, d * 0.3, rotation)
      this.add('box', 'stone', [0.9, h * 0.5 + w * 0.45, 0.9], [x + cx, h * 0.6, z + cz], rotation)
    }
    return this
  }

  /** A straight wall from (x0, z0) to (x1, z1), with merlons along the top every `merlonEvery` metres (0 = none). */
  wall(x0: number, z0: number, x1: number, z1: number, h: number, thick: number, material: Material = 'stone', merlonEvery = 3): this {
    const dx = x1 - x0
    const dz = z1 - z0
    const length = Math.hypot(dx, dz)
    const rotation = Math.atan2(-dz, dx) * DEG
    this.add('box', material, [length, h, thick], [(x0 + x1) / 2, 0, (z0 + z1) / 2], rotation)
    if (merlonEvery > 0) {
      const n = Math.floor(length / merlonEvery)
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n
        this.add('box', material, [merlonEvery * 0.5, 1.2, thick], [x0 + dx * t, h, z0 + dz * t], rotation)
      }
    }
    return this
  }

  /** A closed ring of walls through `points`. */
  ring(points: [number, number][], h: number, thick: number, material: Material = 'stone', merlonEvery = 3): this {
    points.forEach(([x, z], i) => {
      const [nx, nz] = points[(i + 1) % points.length]!
      this.wall(x, z, nx, nz, h, thick, material, merlonEvery)
    })
    return this
  }

  /** A round tower, roofed with a cone or crowned with merlons. */
  roundTower(x: number, z: number, r: number, h: number, opts: { material?: Material; roof?: 'cone' | 'merlons'; roofColor?: string } = {}): this {
    const material = opts.material ?? 'stone'
    this.add('cylinder', material, [r * 2, h, r * 2], [x, 0, z])
    if ((opts.roof ?? 'cone') === 'cone') {
      this.add('cone', 'wood', [r * 2.5, r * 2.4, r * 2.5], [x, h, z], 0, opts.roofColor ?? '#4f3a33')
    } else {
      const n = Math.max(6, Math.round(r * 2.4))
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        this.add('box', material, [r * 0.45, 1.3, r * 0.3], [x + Math.cos(a) * r * 0.85, h, z + Math.sin(a) * r * 0.85], -a * DEG)
      }
    }
    return this
  }

  /** A square tower with merlons at its corners and between. */
  squareTower(x: number, z: number, w: number, h: number, material: Material = 'stone', rotation = 0): this {
    this.add('box', material, [w, h, w], [x, 0, z], rotation)
    for (const [mx, mz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const [ox, oz] = turn(mx * w * 0.4, mz * w * 0.4, rotation)
      this.add('box', material, [w * 0.18, 1.4, w * 0.18], [x + ox, h, z + oz], rotation)
    }
    return this
  }

  /** A church or chapel: nave with a gable roof and a steepled tower at the front. */
  church(x: number, z: number, scale: number, rotation = 0): this {
    const w = 10 * scale
    const d = 22 * scale
    this.add('box', 'stone', [w, 9 * scale, d], [x, 0, z], rotation)
    this.add('wedge', 'wood', [w * 1.1, 6 * scale, d * 1.04], [x, 9 * scale, z], rotation, '#5a4a48')
    const [tx, tz] = turn(0, d / 2 + 2.5 * scale, rotation)
    this.add('box', 'stone', [5.5 * scale, 18 * scale, 5.5 * scale], [x + tx, 0, z + tz], rotation)
    this.add('pyramid', 'wood', [6 * scale, 9 * scale, 6 * scale], [x + tx, 18 * scale, z + tz], rotation, '#3f4652')
    return this
  }

  tree(x: number, z: number, h: number): this {
    this.add('cylinder', 'wood', [h * 0.08, h * 0.4, h * 0.08], [x, 0, z])
    if (this.random() < 0.5) this.add('cone', 'wood', [h * 0.45, h * 0.75, h * 0.45], [x, h * 0.25, z], 0, this.pick(['#2f5d33', '#3b6b3a', '#2c4f35']))
    else this.add('sphere', 'wood', [h * 0.55, h * 0.6, h * 0.55], [x, h * 0.35, z], 0, this.pick(['#4a7a3a', '#3f6e36', '#5b8040']))
    return this
  }

  /** A ploughed or planted field: a low slab of earth. */
  field(x: number, z: number, w: number, d: number, rotation = 0): this {
    return this.add('box', 'earth', [w, 0.25, d], [x, 0, z], rotation, this.pick(['#7f8f43', '#9a8a4a', '#6f8a3f', '#8a6f45', '#a39b55']))
  }

  tent(x: number, z: number, r: number, color: string): this {
    return this.add('cone', 'cloth', [r * 2, r * 1.6, r * 2], [x, 0, z], 0, color)
  }

  /** A ridge tent or pavilion: low walls with a cloth gable roof. */
  pavilion(x: number, z: number, w: number, d: number, color: string, rotation = 0): this {
    this.add('box', 'cloth', [w, 1.6, d], [x, 0, z], rotation, color)
    return this.add('wedge', 'cloth', [w * 1.05, w * 0.55, d * 1.02], [x, 1.6, z], rotation, color)
  }

  campfire(x: number, z: number): this {
    this.add('cylinder', 'stone', [1.6, 0.35, 1.6], [x, 0, z])
    return this.add('cone', 'wood', [1, 1.1, 1], [x, 0.35, z], 0, '#e8762c')
  }

  flag(x: number, z: number, h: number, color: string): this {
    this.add('cylinder', 'wood', [0.15, h, 0.15], [x, 0, z])
    return this.add('box', 'cloth', [1.6, 1, 0.05], [x + 0.8, h - 1.1, z], 0, color)
  }

  build(id: string, name: string, maintainedByDefault: boolean, tags: string[]): Blueprint {
    return { id: `builtin:${id}`, ownerId: 'builtin', createdAt: '', updatedAt: '', deletedAt: null, name, parts: this.parts, model: null, maintainedByDefault, tags }
  }
}

/** Points on a circle, for ring walls and towers. */
const circle = (n: number, r: number, offset = 0): [number, number][] =>
  Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2 + offset) * r, Math.sin((i / n) * Math.PI * 2 + offset) * r])

function stoneCastle(): Blueprint {
  const k = new Kit(seeded(11))
  const half = 32
  const corners: [number, number][] = [[-half, -half], [half, -half], [half, half], [-half, half]]
  // Curtain walls with a walkway's worth of merlons; the south wall leaves room for the gatehouse.
  k.wall(-half, -half, half, -half, 11, 3)
  k.wall(half, -half, half, half, 11, 3)
  k.wall(-half, half, -half, -half, 11, 3)
  k.wall(-half, half, -7, half, 11, 3)
  k.wall(7, half, half, half, 11, 3)
  for (const [x, z] of corners) k.roundTower(x, z, 5, 17, { roof: 'cone', roofColor: '#3d4a5c' })
  // Mid-wall towers.
  for (const [x, z] of [[0, -half], [half, 0], [-half, 0]] as const) k.squareTower(x, z, 7, 14)
  // Gatehouse: two towers, an arch over the gate, a portcullis.
  k.roundTower(-7, half, 4, 16, { roof: 'merlons' })
  k.roundTower(7, half, 4, 16, { roof: 'merlons' })
  k.add('box', 'stone', [10, 5, 4], [0, 8, half])
  k.add('box', 'iron', [6, 8, 0.4], [0, 0, half + 1.6], 0, '#3a3a40')
  // Keep with corner turrets.
  k.add('box', 'stone', [18, 26, 18], [-8, 0, -8])
  for (const [x, z] of [[-17, -17], [1, -17], [1, 1], [-17, 1]] as const) k.roundTower(x, z, 2.2, 31, { roof: 'cone', roofColor: '#3d4a5c' })
  for (let i = 0; i < 6; i++) {
    k.add('box', 'stone', [2, 1.4, 1], [-15 + i * 2.8, 26, -16.5])
    k.add('box', 'stone', [2, 1.4, 1], [-15 + i * 2.8, 26, 0.5])
  }
  // Great hall, chapel, stables, smithy, well.
  k.house(16, -14, 12, 22, 9, 0, { wall: 'stone', roof: 'wood', wallColor: '#a8a296', roofColor: '#4d3a30', chimney: true })
  k.church(-18, 18, 0.55, 90)
  k.house(18, 16, 8, 18, 5, 90, { wall: 'wood', roof: 'thatch', wallColor: '#8b6a48', roofColor: '#b99a5a' })
  k.house(4, 18, 7, 7, 4, 0, { wall: 'stone', roof: 'wood', chimney: true })
  k.add('cylinder', 'stone', [3, 1, 3], [6, 0, 2])
  k.flag(-8, -8, 34, '#b02e2e')
  return k.build('castle', 'Stone castle', true, ['castle', 'fortification'])
}

function motteAndBailey(): Blueprint {
  const k = new Kit(seeded(12))
  // The motte: an earth mound with a wooden tower in its own palisade.
  k.add('cone', 'earth', [36, 14, 36], [-25, 0, 0], 0, '#6f7a45')
  k.add('cylinder', 'earth', [18, 4, 18], [-25, 9, 0], 0, '#6f7a45')
  k.add('box', 'wood', [9, 10, 9], [-25, 13, 0], 0, '#7a5a3a')
  k.add('pyramid', 'wood', [10, 4, 10], [-25, 23, 0], 0, '#5a3f2a')
  k.ring(circle(10, 8.5).map(([x, z]) => [x - 25, z]), 3.5, 0.6, 'wood', 0)
  // The bailey: a palisaded yard with a ditch.
  const bailey = circle(14, 30).map(([x, z]) => [x * 1.2 + 18, z] as [number, number])
  k.ring(bailey, 4.5, 0.6, 'wood', 0)
  for (const [x, z] of bailey) k.add('cone', 'wood', [0.9, 1.2, 0.9], [x, 4.5, z], 0, '#6b4b2e')
  k.squareTower(52, 0, 6, 8, 'wood')
  k.house(14, -12, 8, 16, 4.5, 90, { roof: 'thatch', roofColor: '#b99a5a' })
  k.house(22, 14, 7, 10, 4, 0, { roof: 'thatch', roofColor: '#c4a463' })
  k.house(8, 10, 6, 8, 3.5, 30, { roof: 'thatch', roofColor: '#b99a5a' })
  k.add('box', 'wood', [30, 0.6, 3], [-6, 3, 0], 0, '#6b4b2e')
  k.flag(-25, 0, 26, '#2e5bb0')
  return k.build('motte', 'Motte and bailey', true, ['castle', 'fortification', 'wooden'])
}

function citadel(): Blueprint {
  const k = new Kit(seeded(13))
  // Three concentric rings rising toward a central keep.
  k.add('cylinder', 'earth', [150, 6, 150], [0, 0, 0], 0, '#6d6650')
  k.ring(circle(16, 72), 10, 4, 'stone', 4)
  for (const [x, z] of circle(8, 72)) k.roundTower(x, z, 5, 15, { roof: 'merlons' })
  k.add('cylinder', 'earth', [100, 8, 100], [0, 0, 0], 0, '#6d6650')
  k.ring(circle(12, 48), 14, 4, 'stone', 4)
  for (const [x, z] of circle(6, 48, Math.PI / 6)) k.roundTower(x, z, 6, 21, { roof: 'cone', roofColor: '#3d4a5c' })
  k.ring(circle(8, 22), 18, 3, 'stone', 3)
  for (const [x, z] of circle(4, 22, Math.PI / 4)) k.roundTower(x, z, 4.5, 25, { roof: 'cone', roofColor: '#2e3a4c' })
  k.add('box', 'stone', [20, 36, 20], [0, 0, 0])
  k.roundTower(0, 0, 5, 46, { roof: 'cone', roofColor: '#2e3a4c' })
  // Barracks and stores between the rings.
  for (const [x, z] of circle(10, 60, 0.15)) k.house(x, z, 7, 16, 5, Math.atan2(z, x) * -DEG, { wall: 'stone', roof: 'wood' })
  for (const [x, z] of circle(6, 35, 0.4)) k.house(x, z, 6, 10, 6, Math.atan2(z, x) * -DEG, { wall: 'stone', roof: 'wood', chimney: true })
  k.flag(0, 0, 54, '#7d2bb0')
  return k.build('citadel', 'Hilltop citadel', true, ['castle', 'fortification', 'city'])
}

function watchtower(): Blueprint {
  const k = new Kit(seeded(14))
  k.add('cylinder', 'stone', [9, 2, 9], [0, 0, 0])
  k.roundTower(0, 0, 3.5, 22, { roof: 'merlons' })
  k.add('cone', 'wood', [7, 5, 7], [0, 23.3, 0], 0, '#4f3a33')
  k.add('box', 'wood', [1.2, 2.4, 0.3], [0, 2, 3.5], 0, '#5a3f2a')
  k.campfire(6, 4)
  k.flag(2, 0, 30, '#b08a2e')
  return k.build('tower', 'Watchtower', true, ['tower', 'fortification'])
}

function village(): Blueprint {
  const k = new Kit(seeded(21))
  // Houses along a winding main street and a few lanes, a church, a green with a well, fields beyond.
  for (let i = -6; i <= 6; i++) {
    const x = i * 13
    const bend = Math.sin(i / 3) * 8
    for (const side of [-1, 1]) {
      if (k.random() < 0.15) continue
      const w = k.between(6, 9)
      const d = k.between(8, 12)
      k.house(x + k.between(-1.5, 1.5), bend + side * k.between(10, 13), w, d, k.between(3.5, 5), side > 0 ? 0 : 180, { roof: k.random() < 0.6 ? 'thatch' : 'wood', roofColor: k.random() < 0.6 ? k.pick(['#b99a5a', '#c4a463', '#a88a4e']) : undefined, chimney: k.random() < 0.5 })
    }
  }
  k.church(0, -38, 0.8, 0)
  k.add('box', 'earth', [24, 0.15, 16], [30, 0, -26], 0, '#5f8a45')
  k.add('cylinder', 'stone', [2.4, 1, 2.4], [30, 0, -26])
  k.add('wedge', 'wood', [3, 1.4, 2.8], [30, 2.2, -26], 0, '#5b3a2a')
  for (let i = 0; i < 6; i++) k.field(-70 + (i % 3) * 32, 55 + Math.floor(i / 3) * 26, 28, 22, k.between(-8, 8))
  for (let i = 0; i < 14; i++) k.tree(k.between(-95, 95), k.random() < 0.5 ? k.between(-75, -50) : k.between(28, 40), k.between(7, 13))
  return k.build('village', 'Village', true, ['village', 'dwelling'])
}

function slum(): Blueprint {
  const k = new Kit(seeded(31))
  const materials: Material[] = ['wood', 'mud', 'wood', 'mud', 'thatch', 'iron']
  const colors = ['#7a6248', '#8b7356', '#6e5a44', '#a08868', '#5f5a52', '#8a7a62', '#6b5f50']
  // Shacks crammed together, crooked, leaning on each other, narrow alleys between clusters.
  for (let gx = -8; gx <= 8; gx++) {
    for (let gz = -6; gz <= 6; gz++) {
      if ((gx + 40) % 5 === 0 || (gz + 40) % 4 === 0) continue
      if (k.random() < 0.12) continue
      const x = gx * 6 + k.between(-1.2, 1.2)
      const z = gz * 6 + k.between(-1.2, 1.2)
      const w = k.between(3, 5.5)
      const d = k.between(3, 5.5)
      const h = k.between(2.2, 3.4)
      const rot = k.between(-12, 12)
      const material = k.pick(materials)
      k.add('box', material, [w, h, d], [x, 0, z], rot, k.pick(colors))
      // A sagging sheet of a roof, sometimes patched with a second piece; now and then a second storey.
      k.add('box', k.pick(['iron', 'wood', 'cloth']), [w + 0.6, 0.15, d + 0.5], [x, h, z], rot + k.between(-4, 4), k.pick(['#6f6a63', '#8a5a3c', '#5a6370', '#9a8f7d']))
      if (k.random() < 0.18) k.add('box', 'wood', [w * 0.7, 2.2, d * 0.7], [x, h + 0.15, z], rot + 6, k.pick(colors))
      if (k.random() < 0.08) k.add('box', 'wood', [0.5, 0.5, 0.5], [x + w / 2 + 0.6, 0, z], rot, '#3a3530')
    }
  }
  // Refuse heaps, a shared well and laundry poles.
  for (let i = 0; i < 6; i++) k.add('cone', 'earth', [k.between(2, 4), k.between(0.8, 1.6), k.between(2, 4)], [k.between(-48, 48), 0, k.between(-36, 36)], 0, '#5b5043')
  k.add('cylinder', 'stone', [2, 0.9, 2], [0, 0, 0])
  for (let i = 0; i < 5; i++) {
    const x = k.between(-40, 40)
    const z = (Math.floor(k.between(-1, 2)) * 4 - 2) * 6
    k.flag(x, z, 3.2, k.pick(['#c94f4f', '#4f7fc9', '#d6c34f', '#e8e8e8']))
  }
  return k.build('slum', 'Slum quarter', false, ['slum', 'dwelling', 'poor'])
}

function warCamp(): Blueprint {
  const k = new Kit(seeded(41))
  const half = 60
  // Palisade and ditch with gates, rows of tents along the streets, a command pavilion at the crossroads.
  k.wall(-half, -half, half, -half, 3.5, 0.6, 'wood', 0)
  k.wall(-half, half, -6, half, 3.5, 0.6, 'wood', 0)
  k.wall(6, half, half, half, 3.5, 0.6, 'wood', 0)
  k.wall(-half, -half, -half, half, 3.5, 0.6, 'wood', 0)
  k.wall(half, -half, half, half, 3.5, 0.6, 'wood', 0)
  for (const [x, z] of [[-half, -half], [half, -half], [half, half], [-half, half], [-6, half], [6, half]] as const) k.squareTower(x, z, 4, 7, 'wood')
  const tentColors = ['#d8cdb4', '#cfc3a5', '#bfb294', '#e2d8c0']
  for (let row = -4; row <= 4; row++) {
    if (row === 0) continue
    for (let col = -5; col <= 5; col++) {
      if (col === 0) continue
      const x = col * 10 + (row % 2) * 2
      const z = row * 12
      if (k.random() < 0.7) k.pavilion(x, z, 4, 6, k.pick(tentColors), 90)
      else k.tent(x, z, 2.6, k.pick(tentColors))
    }
  }
  k.pavilion(0, 0, 10, 16, '#a33b3b', 0)
  k.flag(0, -10, 10, '#a33b3b')
  for (let i = -2; i <= 2; i++) k.campfire(i * 22 + 5, 6)
  // Horse lines, supply carts, a smithy.
  for (let i = 0; i < 10; i++) k.add('box', 'wood', [1.8, 0.9, 3.4], [-48 + i * 3, 0, -52], 0, '#5b4532')
  k.house(45, -48, 6, 8, 3, 0, { roof: 'wood', chimney: true })
  for (let i = 0; i < 8; i++) k.flag(-half + i * (half / 4), -half, 7, '#a33b3b')
  return k.build('war-camp', 'War camp', true, ['camp', 'military', 'temporary'])
}

function nomadCamp(): Blueprint {
  const k = new Kit(seeded(42))
  const felt = ['#e8e0cc', '#d9cfb4', '#cdbf9e', '#efe7d6']
  // Yurts in a loose ring around a chief's yurt, with corrals and fires.
  for (const [x, z] of circle(12, 34, 0.2)) {
    const r = k.between(3, 4.5)
    const c = k.pick(felt)
    k.add('cylinder', 'cloth', [r * 2, 2.2, r * 2], [x, 0, z], 0, c)
    k.add('cone', 'cloth', [r * 2.1, r * 0.8, r * 2.1], [x, 2.2, z], 0, c)
    k.add('box', 'wood', [1, 1.6, 0.2], [x * 0.9, 0, z * 0.9], Math.atan2(z, x) * -DEG + 90, '#8a3b2a')
  }
  k.add('cylinder', 'cloth', [14, 3, 14], [0, 0, 0], 0, '#f1e9d8')
  k.add('cone', 'cloth', [14.5, 5, 14.5], [0, 3, 0], 0, '#b23a3a')
  for (const [x, z] of circle(4, 18, Math.PI / 4)) k.campfire(x, z)
  // A corral of posts.
  for (const [x, z] of circle(16, 14)) k.add('cylinder', 'wood', [0.3, 1.5, 0.3], [x + 60, 0, z], 0, '#6b4b2e')
  for (let i = 0; i < 6; i++) k.add('box', 'cloth', [0.8, 1.4, 2], [60 + k.between(-8, 8), 0, k.between(-8, 8)], k.between(0, 180), '#6b4a32')
  return k.build('nomad-camp', 'Nomad camp', false, ['camp', 'nomad', 'temporary'])
}

function cathedralParts(k: Kit, x: number, z: number, s: number, rotation: number): void {
  const at = (lx: number, lz: number): [number, number] => {
    const [dx, dz] = turn(lx * s, lz * s, rotation)
    return [x + dx, z + dz]
  }
  const put = (shape: Shape, material: Material, size: V3, lx: number, y: number, lz: number, color?: string) => {
    const [px, pz] = at(lx, lz)
    k.add(shape, material, [size[0] * s, size[1] * s, size[2] * s], [px, y * s, pz], rotation, color)
  }
  // Nave, aisles, transept, choir and apse; twin west towers with spires; buttresses; a crossing spire.
  put('box', 'stone', [16, 28, 70], 0, 0, 0)
  put('wedge', 'wood', [17, 11, 71], 0, 28, 0, '#4b5866')
  for (const side of [-1, 1]) {
    put('box', 'stone', [8, 14, 60], side * 12, 0, 2)
    put('wedge', 'wood', [8.5, 4, 61], side * 12, 14, 2, '#4b5866')
    for (let i = 0; i < 8; i++) put('box', 'stone', [2.5, 18, 2], side * 17.5, 0, -26 + i * 8)
  }
  put('box', 'stone', [52, 26, 14], 0, 0, 12)
  put('wedge', 'wood', [14, 10, 53], 0, 26, 12, '#4b5866')
  k.parts[k.parts.length - 1]!.rotation = rotation + 90
  put('cylinder', 'stone', [16, 24, 16], 0, 0, 38)
  put('cone', 'wood', [17, 10, 17], 0, 24, 38, '#4b5866')
  for (const side of [-1, 1]) {
    put('box', 'stone', [12, 48, 12], side * 9, 0, -38)
    put('pyramid', 'wood', [11, 24, 11], side * 9, 48, -38, '#3f4652')
    for (const [mx, mz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) put('cone', 'stone', [1.6, 6, 1.6], side * 9 + mx * 5.5, 48, -38 + mz * 5.5)
  }
  put('box', 'stone', [8, 22, 1], 0, 0, -44)
  put('cylinder', 'glass', [7, 7, 1], 0, 16, -44.2, '#5a7fb8')
  put('box', 'stone', [6, 10, 6], 0, 36, 12)
  put('pyramid', 'iron', [5, 22, 5], 0, 46, 12, '#3a4a52')
}

function cathedral(): Blueprint {
  const k = new Kit(seeded(51))
  cathedralParts(k, 0, 0, 1, 0)
  k.add('box', 'stone', [44, 0.4, 30], [0, 0, -58], 0, '#8a857a')
  for (let i = 0; i < 8; i++) k.tree(-30 + (i % 4) * 20, 30 + Math.floor(i / 4) * 16, k.between(8, 12))
  return k.build('cathedral', 'Cathedral', true, ['religious', 'cathedral', 'monument'])
}

function palaceParts(k: Kit, x: number, z: number, s: number): void {
  const put = (shape: Shape, material: Material, size: V3, lx: number, y: number, lz: number, color?: string, rotation = 0) =>
    k.add(shape, material, [size[0] * s, size[1] * s, size[2] * s], [x + lx * s, y * s, z + lz * s], rotation, color)
  // Central block with a great dome and drum, colonnaded wings around a courtyard, corner pavilions with small domes.
  put('box', 'stone', [60, 24, 36], 0, 0, 0, '#e3dccb')
  put('cylinder', 'stone', [26, 10, 26], 0, 24, 0, '#e3dccb')
  put('sphere', 'stone', [26, 26, 26], 0, 21, 0, '#c9b46a')
  put('cone', 'iron', [3, 8, 3], 0, 46, 0, '#c9a94a')
  for (const side of [-1, 1]) {
    put('box', 'stone', [16, 16, 70], side * 38, 0, 40, '#e3dccb')
    put('wedge', 'stone', [17, 5, 71], side * 38, 16, 40, '#9a5b3c')
    put('box', 'stone', [20, 22, 20], side * 38, 0, 82, '#e3dccb')
    put('sphere', 'stone', [14, 14, 14], side * 38, 18, 82, '#c9b46a')
    for (let i = 0; i < 9; i++) put('cylinder', 'stone', [1.6, 12, 1.6], side * 28, 0, 10 + i * 7, '#f0ead8')
  }
  for (let i = 0; i < 10; i++) put('cylinder', 'stone', [2, 18, 2], -27 + i * 6, 0, 20, '#f0ead8')
  put('box', 'stone', [60, 3, 4], 0, 18, 20, '#e3dccb')
  // Courtyard, fountain, gardens and a gate.
  put('box', 'stone', [56, 0.3, 60], 0, 0, 52, '#cfc6b0')
  put('cylinder', 'stone', [10, 1.2, 10], 0, 0, 52, '#d8d0bc')
  put('cylinder', 'stone', [2, 5, 2], 0, 1.2, 52, '#d8d0bc')
  for (let i = 0; i < 12; i++) put('cone', 'wood', [3, 6, 3], -25 + (i % 6) * 10, 0, 34 + Math.floor(i / 6) * 36, '#2f5d33')
  put('box', 'iron', [16, 6, 0.6], 0, 0, 92, '#2b2b30')
  for (const side of [-1, 1]) put('box', 'stone', [3, 8, 3], side * 9.5, 0, 92, '#e3dccb')
}

function palace(): Blueprint {
  const k = new Kit(seeded(52))
  palaceParts(k, 0, 0, 1)
  return k.build('palace', 'Palace', true, ['palace', 'royal', 'monument'])
}

function city(): Blueprint {
  const k = new Kit(seeded(61))
  const R = 300
  // Walls: a 24-sided ring with round towers and four gatehouses on the main roads.
  const ring = circle(24, R)
  ring.forEach(([x, z], i) => {
    const [nx, nz] = ring[(i + 1) % ring.length]!
    k.wall(x, z, nx, nz, 14, 5, 'stone', 0)
  })
  ring.forEach(([x, z], i) => (i % 6 === 0 ? k.squareTower(x, z, 16, 24) : k.roundTower(x, z, 6, 20, { roof: 'cone', roofColor: '#3d4a5c' })))
  // The citadel on the north side, the cathedral east of the square, the palace south.
  k.ring(circle(10, 46).map(([x, z]): [number, number] => [x, z - 170]), 16, 4, 'stone', 4)
  k.add('box', 'stone', [26, 34, 26], [0, 0, -170])
  for (const [x, z] of circle(5, 46).map(([x, z]): [number, number] => [x, z - 170])) k.roundTower(x, z, 5, 22, { roof: 'cone', roofColor: '#2e3a4c' })
  cathedralParts(k, 70, -10, 0.8, 90)
  palaceParts(k, -10, 130, 0.7)
  // The great square: paving, fountain, market stalls.
  k.add('box', 'stone', [90, 0.3, 70], [0, 0, 0], 0, '#a69d8a')
  k.add('cylinder', 'stone', [8, 1, 8], [0, 0, 0])
  k.add('cylinder', 'stone', [1.5, 4, 1.5], [0, 1, 0])
  for (let i = 0; i < 16; i++) k.pavilion(-38 + (i % 8) * 10, i < 8 ? -22 : 22, 4, 5, k.pick(['#b03a3a', '#3a6fb0', '#d0a83a', '#e8e0cc', '#3a8a55']), 0)
  // Streets of houses on a grid, leaving the main roads, the square and the big buildings clear.
  const reserved = (x: number, z: number) =>
    Math.abs(x) < 9 || Math.abs(z) < 9 || (Math.abs(x) < 52 && Math.abs(z) < 42) || Math.hypot(x, z + 170) < 56 || (x > 30 && x < 115 && Math.abs(z + 10) < 50) || (Math.abs(x + 10) < 75 && z > 100 && z < 210)
  const step = 24
  for (let gx = -12; gx <= 12; gx++) {
    for (let gz = -12; gz <= 12; gz++) {
      const x = gx * step + k.between(-2, 2)
      const z = gz * step + k.between(-2, 2)
      if (Math.hypot(x, z) > R - 26 || reserved(x, z)) continue
      // Two to four houses per block, taller toward the centre.
      const n = 2 + Math.floor(k.random() * 3)
      const tall = 1 + (1 - Math.hypot(x, z) / R) * 0.8
      for (let i = 0; i < n; i++) {
        const ox = (i % 2) * 10 - 5
        const oz = Math.floor(i / 2) * 10 - 5
        k.house(x + ox, z + oz, k.between(7, 9), k.between(8, 10), k.between(6, 11) * tall, k.pick([0, 90]), {
          wall: k.random() < 0.6 ? 'brick' : 'wood',
          roof: 'wood',
          chimney: k.random() < 0.3
        })
      }
    }
  }
  // Orchards and fields outside the walls.
  for (let i = 0; i < 10; i++) {
    const [x, z] = circle(10, R + 70, 0.3)[i]!
    k.field(x, z, 60, 40, Math.atan2(z, x) * -DEG)
  }
  return k.build('city', 'Walled city (vast)', true, ['city', 'capital', 'fortification'])
}

function harbour(): Blueprint {
  const k = new Kit(seeded(71))
  // Quay along the water, piers, warehouses, a lighthouse on the mole, houses climbing up behind.
  k.add('box', 'stone', [180, 3, 14], [0, 0, 0], 0, '#8f8a7e')
  for (let i = 0; i < 5; i++) {
    const x = -70 + i * 35
    k.add('box', 'wood', [6, 1.2, 40], [x, 1.5, 27], 0, '#6b5038')
    for (let j = 0; j < 5; j++) for (const side of [-1, 1]) k.add('cylinder', 'wood', [0.6, 3, 0.6], [x + side * 2.6, 0, 10 + j * 9], 0, '#4a3828')
  }
  for (let i = 0; i < 6; i++) k.house(-75 + i * 30, -16, 22, 14, 9, 90, { wall: 'brick', roof: 'wood', wallColor: '#8f5a44', roofColor: '#4d4a52' })
  k.add('box', 'stone', [8, 3, 70], [100, 0, 30], 0, '#8f8a7e')
  k.add('cylinder', 'stone', [8, 26, 8], [100, 3, 62], 0, '#e8e2d6')
  k.add('cylinder', 'glass', [6, 4, 6], [100, 29, 62], 0, '#f6e7a1')
  k.add('cone', 'iron', [7, 3, 7], [100, 33, 62], 0, '#9a3a2a')
  for (let i = 0; i < 24; i++) k.house(-80 + (i % 8) * 22 + k.between(-3, 3), -38 - Math.floor(i / 8) * 18, k.between(7, 9), k.between(8, 10), k.between(5, 8), k.pick([0, 90]), { chimney: k.random() < 0.4 })
  // Boats moored at the piers.
  for (let i = 0; i < 6; i++) {
    const x = -62 + i * 25 + k.between(-2, 2)
    k.add('box', 'wood', [3.5, 1.4, 12], [x, 0, 30], 0, '#5b4532')
    k.add('cylinder', 'wood', [0.3, 9, 0.3], [x, 1.4, 30], 0, '#4a3828')
    k.add('box', 'cloth', [0.1, 6, 5], [x, 3, 30], 0, '#e8e0cc')
  }
  return k.build('harbour', 'Harbour town', true, ['harbour', 'coast', 'town'])
}

function arena(): Blueprint {
  const k = new Kit(seeded(81))
  // Two tiers of arcades around an oval, an attic storey, the sand floor, gates.
  const n = 40
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const x = Math.cos(a) * 78
    const z = Math.sin(a) * 62
    const rot = -Math.atan2(z / 62 ** 2, x / 78 ** 2) * DEG
    k.add('box', 'stone', [11, 16, 6], [x, 0, z], rot + 90, '#cdbf9e')
    k.add('box', 'stone', [11, 14, 5], [x * 0.98, 16, z * 0.98], rot + 90, '#d6c9aa')
    k.add('box', 'stone', [11, 8, 4], [x * 0.96, 30, z * 0.96], rot + 90, '#c4b593')
    k.add('box', 'stone', [10, 10, 12], [x * 0.84, 0, z * 0.84], rot + 90, '#b9aa88')
  }
  k.add('cylinder', 'earth', [110, 0.5, 86], [0, 0, 0], 0, '#d9c9a0')
  for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) k.add('box', 'iron', [8, 7, 1], [Math.cos(a) * 82, 0, Math.sin(a) * 66], -a * DEG + 90, '#3a3a40')
  return k.build('arena', 'Arena', true, ['arena', 'monument', 'entertainment'])
}

function ziggurat(): Blueprint {
  const k = new Kit(seeded(82))
  const tiers = [
    [90, 14],
    [68, 12],
    [48, 10],
    [30, 8]
  ] as const
  let y = 0
  for (const [w, h] of tiers) {
    k.add('box', 'mud', [w, h, w], [0, y, 0], 0, '#b08a5a')
    y += h
  }
  k.add('box', 'brick', [16, 8, 16], [0, y, 0], 0, '#3d5a8a')
  for (const side of [0, 90, 180]) {
    const [x, z] = turn(0, 50, side)
    k.add('wedge', 'mud', [10, 44, 40], [x * 0.75, 0, z * 0.75], side + 90, '#a07a4c')
  }
  return k.build('ziggurat', 'Ziggurat', false, ['temple', 'monument', 'ancient'])
}

function stoneCircle(): Blueprint {
  const k = new Kit(seeded(83))
  const n = 30
  // An outer ring of uprights joined by lintels, an inner horseshoe of great trilithons, and a heel stone.
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    k.add('box', 'megalith', [2.1, 4.1, 1.1], [Math.cos(a) * 16, 0, Math.sin(a) * 16], -a * DEG + 90)
    const b = ((i + 0.5) / n) * Math.PI * 2
    k.add('box', 'megalith', [3.6, 0.8, 1], [Math.cos(b) * 16, 4.1, Math.sin(b) * 16], -b * DEG + 90)
  }
  for (let i = 0; i < 5; i++) {
    const a = Math.PI * (0.25 + i * 0.375)
    const [x, z] = [Math.cos(a) * 9, Math.sin(a) * 9]
    for (const s of [-1, 1]) k.add('box', 'megalith', [2.2, 6.5, 1.3], [x + Math.sin(a) * s * 1.4, 0, z - Math.cos(a) * s * 1.4], -a * DEG + 90)
    k.add('box', 'megalith', [5.2, 1, 1.3], [x, 6.5, z], -a * DEG + 90)
  }
  k.add('box', 'megalith', [2.4, 5, 1.6], [0, 0, -34], 12)
  k.add('cylinder', 'earth', [44, 0.6, 44], [0, 0, 0], 0, '#7d8a52')
  return k.build('stone-circle', 'Stone circle', false, ['monument', 'ancient', 'religious'])
}

function windmill(): Blueprint {
  const k = new Kit(seeded(84))
  k.add('cylinder', 'stone', [8, 12, 8], [0, 0, 0], 0, '#d6cbb5')
  k.add('cone', 'wood', [8.6, 5, 8.6], [0, 12, 0], 0, '#5b3a2a')
  // Sails: a cross of lattice blades on the front.
  k.add('box', 'wood', [1.4, 22, 0.3], [0, 3, 4.6], 0, '#e8e0cc')
  k.add('box', 'wood', [22, 1.4, 0.3], [0, 13.3, 4.6], 0, '#e8e0cc')
  k.add('cylinder', 'wood', [1.2, 1.2, 1.2], [0, 13.3, 4.5], 0, '#4a3828')
  k.house(12, 4, 6, 8, 3.5, 0, { roof: 'thatch', roofColor: '#b99a5a' })
  for (let i = 0; i < 4; i++) k.field(-20 + (i % 2) * 24, -22 + Math.floor(i / 2) * 20, 20, 16)
  return k.build('windmill', 'Windmill', true, ['mill', 'farm'])
}

function farmstead(): Blueprint {
  const k = new Kit(seeded(85))
  k.house(0, 0, 9, 14, 5, 0, { wall: 'stone', roof: 'thatch', roofColor: '#b99a5a', chimney: true })
  k.house(22, -4, 12, 22, 7, 90, { wall: 'wood', roof: 'wood', wallColor: '#8a3b2a', roofColor: '#4d4a52' })
  k.add('cylinder', 'wood', [5, 12, 5], [34, 0, 10], 0, '#9a9a90')
  k.add('cone', 'iron', [5.4, 2.4, 5.4], [34, 12, 10], 0, '#6a6a70')
  k.house(8, 18, 5, 6, 2.6, 0, { roof: 'wood' })
  // Fences around a paddock, fields, an orchard.
  for (const [x0, z0, x1, z1] of [[-14, 26, 20, 26], [20, 26, 20, 50], [20, 50, -14, 50], [-14, 50, -14, 26]] as const) k.wall(x0, z0, x1, z1, 1.2, 0.2, 'wood', 0)
  for (let i = 0; i < 8; i++) k.field(-90 + (i % 4) * 38, -50 + Math.floor(i / 4) * 34, 34, 30, k.between(-3, 3))
  for (let i = 0; i < 12; i++) k.tree(50 + (i % 4) * 8, -20 + Math.floor(i / 4) * 8, k.between(5, 7))
  return k.build('farmstead', 'Farmstead', true, ['farm', 'dwelling', 'rural'])
}

function mine(): Blueprint {
  const k = new Kit(seeded(86))
  // A timbered adit into a hillside, spoil heaps, a winding tower, sheds, carts on rails.
  k.add('cone', 'earth', [60, 22, 50], [0, 0, -20], 0, '#6d6250')
  k.add('box', 'wood', [6, 5, 1], [0, 0, 4], 0, '#4a3828')
  k.add('box', 'stone', [4, 4, 1.2], [0, 0, 4.3], 0, '#1a1814')
  k.add('box', 'wood', [3, 14, 3], [22, 0, 12], 0, '#5b4532')
  k.add('wedge', 'wood', [4, 3, 4], [22, 14, 12], 0, '#4a3828')
  k.add('cylinder', 'wood', [3.5, 0.6, 3.5], [22, 12, 14], 0, '#3a3530')
  for (let i = 0; i < 4; i++) k.add('cone', 'earth', [k.between(10, 16), k.between(4, 7), k.between(10, 16)], [-30 + i * 14, 0, 26 + k.between(-4, 4)], 0, '#4f4a44')
  k.house(-18, 8, 7, 10, 3.5, 0, { roof: 'wood' })
  k.house(30, -6, 8, 14, 4, 90, { roof: 'wood', chimney: true })
  k.add('box', 'iron', [1.6, 0.2, 40], [0, 0, 24], 0, '#5a5550')
  for (let i = 0; i < 3; i++) k.add('box', 'wood', [1.6, 1.2, 2.4], [0, 0.2, 10 + i * 6], 0, '#5b4532')
  return k.build('mine', 'Mine', true, ['mine', 'industry'])
}

function simple(id: string, name: string, maintained: boolean, tags: string[], fill: (k: Kit) => void): Blueprint {
  const k = new Kit(seeded(id.length * 97))
  fill(k)
  return k.build(id, name, maintained, tags)
}

/** Blueprints every project has. Users copy one to make their own version. */
export const BUILTIN_BLUEPRINTS: Blueprint[] = [
  stoneCastle(),
  motteAndBailey(),
  citadel(),
  city(),
  village(),
  slum(),
  warCamp(),
  nomadCamp(),
  harbour(),
  cathedral(),
  palace(),
  arena(),
  farmstead(),
  windmill(),
  mine(),
  watchtower(),
  simple('house', 'House', true, ['house', 'dwelling'], (k) => k.house(0, 0, 8, 10, 4, 0, { roof: 'thatch', roofColor: '#b99a5a', chimney: true })),
  simple('temple', 'Temple', true, ['temple', 'religious'], (k) => {
    k.add('box', 'stone', [26, 2, 16])
    for (const x of [-11, -6.6, -2.2, 2.2, 6.6, 11]) for (const z of [-6.5, 6.5]) k.add('cylinder', 'stone', [1.6, 9, 1.6], [x, 2, z])
    k.add('box', 'stone', [16, 9, 9], [0, 2, 0])
    k.add('box', 'stone', [26, 1.2, 16], [0, 11, 0])
    k.add('wedge', 'stone', [26, 3.5, 16], [0, 12.2, 0], 90)
  }),
  simple('lighthouse', 'Lighthouse', true, ['tower', 'coast'], (k) => {
    k.add('cylinder', 'stone', [12, 3, 12], [0, 0, 0])
    k.add('cylinder', 'brick', [7, 26, 7], [0, 3, 0], 0, '#e8e2d6')
    for (let i = 0; i < 4; i++) k.add('cylinder', 'brick', [7.1, 2, 7.1], [0, 6 + i * 6, 0], 0, '#b03a2e')
    k.add('cylinder', 'iron', [9, 0.6, 9], [0, 29, 0], 0, '#3a3a40')
    k.add('cylinder', 'glass', [4.5, 4, 4.5], [0, 29.6, 0], 0, '#f6e7a1')
    k.add('cone', 'iron', [5.5, 3, 5.5], [0, 33.6, 0], 0, '#3a3a40')
    k.house(10, 0, 6, 8, 3.5, 0, { wall: 'stone', roof: 'wood' })
  }),
  simple('bridge', 'Stone bridge', true, ['bridge'], (k) => {
    k.add('box', 'stone', [80, 2, 8], [0, 9, 0])
    for (const x of [-30, -10, 10, 30]) k.add('box', 'stone', [5, 9, 8], [x, 0, 0])
    for (const side of [-1, 1]) for (let i = 0; i < 20; i++) k.add('box', 'stone', [2, 1, 0.6], [-38 + i * 4, 11, side * 3.7])
  }),
  simple('standing-stone', 'Standing stone', false, ['monument'], (k) => void k.add('box', 'megalith', [1.5, 5, 0.8], [0, 0, 0], 8)),
  stoneCircle(),
  ziggurat(),
  simple('pyramid', 'Pyramid', false, ['monument', 'tomb'], (k) => {
    k.add('pyramid', 'megalith', [230, 140, 230], [0, 0, 0], 0, '#d8c9a3')
    k.add('pyramid', 'stone', [8, 5, 8], [0, 140, 0], 0, '#e8d27a')
  })
]

/** A blueprint by id among the built-in ones and a project's own. */
export const findBlueprint = (library: Blueprint[], id: string): Blueprint | undefined => BUILTIN_BLUEPRINTS.find((b) => b.id === id) ?? library.find((b) => b.id === id)
