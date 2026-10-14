import { rng, type GalaxyFeatureKind } from '@universe/procgen'

/**
 * How space looks above the ground (PLAN.md §5.2, §5.5): the sky behind
 * every level, with nebulae and stars of every colour, and the lights drawn
 * on it (spiked bright stars, a sun's corona, a planet's air). The costly
 * parts are drawn once into images and stamped after.
 */

type Rgb = readonly [number, number, number]
const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${a.toFixed(3)})`
/** `#rrggbb` as numbers. */
export const hexRgb = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]

/** A disc of light: a radial gradient through `stops` (from `inner` px out to `radius`), filled. */
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, stops: [number, string][], inner = 0): void {
  const g = ctx.createRadialGradient(x, y, inner, x, y, radius)
  for (const [at, colour] of stops) g.addColorStop(at, colour)
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
}

/** A hue (degrees) at the given saturation and lightness (0–1), as numbers. */
export function hslRgb(hue: number, sat: number, light: number): Rgb {
  const f = (n: number) => {
    const k = (n + hue / 30) % 12
    return Math.round(255 * (light - sat * Math.min(light, 1 - light) * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [f(0), f(8), f(4)]
}

/** Nebula colours that go together: each sky picks one. */
const NEBULAE: Rgb[][] = [
  [
    [126, 84, 230],
    [46, 140, 210],
    [214, 78, 158]
  ],
  [
    [40, 150, 170],
    [96, 92, 220],
    [70, 190, 150]
  ],
  [
    [210, 96, 120],
    [130, 70, 200],
    [235, 150, 90]
  ],
  [
    [70, 110, 235],
    [170, 80, 210],
    [60, 170, 220]
  ]
]

/** Star colours from hot to cool, and how common each is in the sky. */
const STAR_COLOURS: [Rgb, number][] = [
  [[155, 180, 255], 0.12],
  [[202, 215, 255], 0.2],
  [[248, 247, 255], 0.28],
  [[255, 240, 222], 0.18],
  [[255, 210, 161], 0.14],
  [[255, 181, 108], 0.08]
]

function starColour(u: number): Rgb {
  for (const [colour, share] of STAR_COLOURS) {
    if (u < share) return colour
    u -= share
  }
  return STAR_COLOURS[2]![0]
}

export interface BackdropOptions {
  /** Background stars. */
  stars: number
  /** How bright its nebulae are, 0 (none) to 1. */
  nebula: number
}

/** Skies by seed, options and size, drawn once. */
const backdrops = new Map<string, HTMLCanvasElement>()

/**
 * The sky behind a level, the same for a seed: a deep gradient, a band of
 * nebulae across it (with darker dust), and stars of every colour, the
 * brightest with spikes.
 */
export function spaceBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, { stars, nebula }: BackdropOptions): void {
  // A view with no size (hidden, as behind another panel on a phone) has no sky to draw.
  if (w < 1 || h < 1) return
  const dpr = window.devicePixelRatio || 1
  const key = `${seed}:${stars}:${nebula}:${w}x${h}@${dpr}`
  let sky = backdrops.get(key)
  if (!sky) {
    sky = paintSky(w, h, dpr, seed, stars, nebula)
    if (backdrops.size >= 8) backdrops.delete(backdrops.keys().next().value!)
    backdrops.set(key, sky)
  }
  ctx.drawImage(sky, 0, 0, w, h)
}

function paintSky(w: number, h: number, dpr: number, seed: number, stars: number, nebula: number): HTMLCanvasElement {
  const sky = document.createElement('canvas')
  sky.width = Math.round(w * dpr)
  sky.height = Math.round(h * dpr)
  const c = sky.getContext('2d')!
  c.scale(dpr, dpr)
  const r = rng(seed ^ 0x51ed27)
  const deep = c.createLinearGradient(0, 0, w, h)
  deep.addColorStop(0, '#070a1a')
  deep.addColorStop(0.55, '#04050c')
  deep.addColorStop(1, '#0b0718')
  c.fillStyle = deep
  c.fillRect(0, 0, w, h)
  if (nebula > 0) c.drawImage(paintNebula(w, h, r, nebula), 0, 0, w, h)
  for (let i = 0; i < stars; i++) {
    const x = r() * w
    const y = r() * h
    const s = r() * r() * 1.7 + 0.25
    c.fillStyle = rgba(starColour(r()), 0.18 + r() * 0.6)
    c.fillRect(x, y, s, s)
  }
  // A few bright ones, with a halo and spikes.
  for (let i = 0; i < Math.round(stars / 45); i++) {
    const x = r() * w
    const y = r() * h
    const colour = starColour(r())
    const size = 0.8 + r() * 1.4
    glow(c, x, y, size * 5, [
      [0, rgba([255, 255, 255], 0.9)],
      [0.25, rgba(colour, 0.35)],
      [1, rgba(colour, 0)]
    ])
    starSpikes(c, x, y, size * (7 + r() * 6), colour, 0.5)
  }
  return sky
}

/**
 * Nebulae at a quarter of the size (they're soft, and many gradients cost
 * at full size), along a band across the sky like a galaxy's plane, with
 * dark dust in front.
 */
function paintNebula(w: number, h: number, r: () => number, strength: number): HTMLCanvasElement {
  const q = 4
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(w / q))
  canvas.height = Math.max(1, Math.ceil(h / q))
  const c = canvas.getContext('2d')!
  c.scale(1 / q, 1 / q)
  const palette = NEBULAE[Math.floor(r() * NEBULAE.length)]!
  const angle = r() * Math.PI
  const [ax, ay] = [Math.cos(angle), Math.sin(angle)]
  const reach = Math.hypot(w, h) / 2
  const along = (t: number, off: number): [number, number] => [w / 2 + ax * t * reach - ay * off, h / 2 + ay * t * reach + ax * off]
  const blob = (x: number, y: number, radius: number, colour: string, edge: string) =>
    glow(c, x, y, radius, [
      [0, colour],
      [1, edge]
    ])
  c.globalCompositeOperation = 'lighter'
  const size = Math.max(w, h)
  for (let i = 0; i < 64; i++) {
    // Thickest in the middle of the band, thinning out from it.
    const [x, y] = along(r() * 2.2 - 1.1, (r() + r() + r() - 1.5) * h * 0.22)
    const colour = palette[Math.floor(r() * palette.length)]!
    blob(x, y, size * (0.05 + r() * 0.2), rgba(colour, strength * (0.025 + r() * 0.06)), rgba(colour, 0))
  }
  c.globalCompositeOperation = 'source-over'
  for (let i = 0; i < 18; i++) {
    const [x, y] = along(r() * 2 - 1, (r() - 0.5) * h * 0.12)
    blob(x, y, size * (0.03 + r() * 0.08), `rgba(2,3,8,${(strength * (0.2 + r() * 0.25)).toFixed(3)})`, 'rgba(2,3,8,0)')
  }
  return canvas
}

/** A bright star's four spikes (and two faint ones), `length` px from its middle. */
export function starSpikes(ctx: CanvasRenderingContext2D, x: number, y: number, length: number, colour: Rgb, alpha: number, turn = 0): void {
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  for (let i = 0; i < 6; i++) {
    const long = i < 4
    const a = turn + (long ? (i * Math.PI) / 2 : Math.PI / 4 + ((i - 4) * Math.PI) / 2)
    const len = long ? length : length * 0.45
    for (const side of [1, -1]) {
      const ex = x + Math.cos(a) * len * side
      const ey = y + Math.sin(a) * len * side
      const g = ctx.createLinearGradient(x, y, ex, ey)
      g.addColorStop(0, rgba([255, 255, 255], alpha * (long ? 1 : 0.5)))
      g.addColorStop(0.3, rgba(colour, alpha * (long ? 0.55 : 0.25)))
      g.addColorStop(1, rgba(colour, 0))
      ctx.strokeStyle = g
      ctx.lineWidth = long ? 1.1 : 0.8
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(ex, ey)
      ctx.stroke()
    }
  }
  ctx.restore()
}

/**
 * A sun as the middle of its system: a wide soft corona, slowly turning
 * rays, a hot glow and spikes. `spin` is wall-clock seconds.
 */
export function drawSun(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, hex: string, spin: number): void {
  const colour = hexRgb(hex)
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  glow(
    ctx,
    x,
    y,
    radius * 12,
    [
      [0, rgba(colour, 0.32)],
      [0.25, rgba(colour, 0.1)],
      [1, rgba(colour, 0)]
    ],
    radius * 0.5
  )
  // Rays of uneven length, turning slowly the other way to each other.
  const r = rng(0x5a17)
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + spin * (i % 2 ? 0.02 : -0.015)
    const len = radius * (4 + r() * 5)
    const spread = 0.05 + r() * 0.06
    const g = ctx.createRadialGradient(x, y, radius, x, y, len)
    g.addColorStop(0, rgba(colour, 0.22))
    g.addColorStop(1, rgba(colour, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.arc(x, y, len, a - spread, a + spread)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
  glow(ctx, x, y, radius * 3, [
    [0, '#ffffff'],
    [0.18, '#fffbf0'],
    [0.35, rgba(colour, 0.9)],
    [1, rgba(colour, 0)]
  ])
  starSpikes(ctx, x, y, radius * 7, colour, 0.55, Math.PI / 12)
}

/** A planet's air: a thin glowing rim, brighter on the side the light comes from (`light`, radians, screen up is positive). */
export function drawAtmosphere(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, colour: Rgb, light: number): void {
  const lx = x + Math.cos(light) * radius * 0.35
  const ly = y - Math.sin(light) * radius * 0.35
  const g = ctx.createRadialGradient(lx, ly, radius * 0.9, x, y, radius * 1.3)
  g.addColorStop(0, rgba(colour, 0.45))
  g.addColorStop(1, rgba(colour, 0))
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, radius * 1.3, 0, Math.PI * 2)
  ctx.arc(x, y, radius * 0.92, 0, Math.PI * 2, true)
  ctx.fill()
  ctx.restore()
}

/** Cluster images by seed. */
const clusterSprites = new Map<number, HTMLCanvasElement>()
const CLUSTER_PX = 128
/** The hot gas in a cluster glows violet, blue or magenta. */
const CLUSTER_GAS: Rgb[] = [
  [160, 110, 255],
  [110, 150, 255],
  [220, 110, 220]
]

/**
 * A galaxy cluster from afar: a glowing knot of hot gas round a bright
 * middle, speckled with galaxies, gold and blue, a few seen edge on.
 */
export function clusterSprite(seed: number): HTMLCanvasElement {
  let sprite = clusterSprites.get(seed)
  if (sprite) return sprite
  sprite = document.createElement('canvas')
  sprite.width = sprite.height = CLUSTER_PX
  const c = sprite.getContext('2d')!
  const half = CLUSTER_PX / 2
  const r = rng(seed ^ 0xc1a5)
  const gas = CLUSTER_GAS[Math.floor(r() * CLUSTER_GAS.length)]!
  c.globalCompositeOperation = 'lighter'
  glow(c, half, half, half, [
    [0, rgba([255, 235, 250], 0.55)],
    [0.18, rgba(gas, 0.32)],
    [0.55, rgba(gas, 0.1)],
    [1, rgba(gas, 0)]
  ])
  for (let i = 0; i < 34; i++) {
    const a = r() * Math.PI * 2
    const d = r() ** 1.5 * half * 0.78
    const x = half + Math.cos(a) * d
    const y = half + Math.sin(a) * d * 0.85
    const gold = r() < 0.55
    const colour: Rgb = gold ? [255, 220, 170] : [170, 200, 255]
    const size = 0.9 + r() * r() * 3.2
    const g = c.createRadialGradient(x, y, 0, x, y, size * 2.2)
    g.addColorStop(0, rgba([255, 252, 245], 0.95))
    g.addColorStop(0.35, rgba(colour, 0.6))
    g.addColorStop(1, rgba(colour, 0))
    c.fillStyle = g
    c.beginPath()
    // A few are spirals seen edge on: thin streaks.
    if (r() < 0.25) c.ellipse(x, y, size * 2.4, size * 0.7, r() * Math.PI, 0, Math.PI * 2)
    else c.arc(x, y, size * 2.2, 0, Math.PI * 2)
    c.fill()
  }
  if (clusterSprites.size > 200) clusterSprites.delete(clusterSprites.keys().next().value!)
  clusterSprites.set(seed, sprite)
  return sprite
}

/** Sprites of what lies in a galaxy besides its stars, by kind and seed, each drawn once. */
const featureSprites = new Map<string, HTMLCanvasElement>()
const FEATURE_PX = 256

/** A gaussian-ish draw from a random source, mostly within ±1. */
const spread = (r: () => number) => (r() + r() + r() - 1.5) / 1.5

/**
 * What lies among a galaxy's stars (procgen's GalaxyFeature), as a sprite
 * FEATURE_PX square, its edge at the feature's radius: a glowing nebula of
 * red hydrogen with a teal heart, a blue reflection nebula round a bright
 * star, dark dust, a supernova's shell of torn filaments, a planetary
 * nebula's ring round its dying star, or a young cluster of blue stars. The
 * glowing ones are drawn with 'lighter', dark dust over what's behind it.
 */
export function galaxyFeatureSprite(kind: GalaxyFeatureKind, seed: number): HTMLCanvasElement {
  const key = `${kind}:${seed}`
  let sprite = featureSprites.get(key)
  if (sprite) return sprite
  sprite = document.createElement('canvas')
  sprite.width = sprite.height = FEATURE_PX
  const c = sprite.getContext('2d')!
  const half = FEATURE_PX / 2
  const r = rng(seed ^ 0x5eed)
  c.globalCompositeOperation = kind === 'dark' ? 'source-over' : 'lighter'
  /** Soft puffs scattered round the middle, `n` of them up to `size` of the radius, in a colour. */
  const puffs = (n: number, size: number, colour: () => Rgb, alpha: number, reach = 0.55) => {
    for (let i = 0; i < n; i++) {
      const x = half + spread(r) * half * reach
      const y = half + spread(r) * half * reach
      const rad = half * size * (0.3 + r() * 0.7)
      const col = colour()
      glow(c, x, y, rad, [
        [0, rgba(col, alpha)],
        [0.5, rgba(col, alpha * 0.4)],
        [1, rgba(col, 0)]
      ])
    }
  }
  const stars = (n: number, reach: number, colour: Rgb) => {
    for (let i = 0; i < n; i++) {
      const x = half + spread(r) * half * reach
      const y = half + spread(r) * half * reach
      const rad = 1 + r() * r() * 3
      glow(c, x, y, rad * 3, [
        [0, 'rgba(255,255,255,0.95)'],
        [0.3, rgba(colour, 0.6)],
        [1, rgba(colour, 0)]
      ])
    }
  }
  if (kind === 'emission') {
    // Hydrogen's red-pink, a heart of teal oxygen in some, lit by the young stars inside.
    const teal = r() < 0.6
    puffs(46, 0.42, () => (r() < 0.75 ? [255, 70 + r() * 40, 120 + r() * 50] : [255, 150, 120]), 0.13)
    if (teal) puffs(14, 0.22, () => [70, 220, 210], 0.12, 0.25)
    stars(6, 0.35, [180, 210, 255])
    // Dark lanes of dust cut through it.
    c.globalCompositeOperation = 'destination-out'
    puffs(10, 0.2, () => [0, 0, 0], 0.5, 0.6)
  } else if (kind === 'reflection') {
    puffs(26, 0.45, () => [90 + r() * 40, 150 + r() * 40, 255], 0.12, 0.4)
    stars(2, 0.1, [200, 220, 255])
  } else if (kind === 'dark') {
    puffs(30, 0.4, () => [8 + r() * 10, 6 + r() * 6, 10 + r() * 8], 0.42, 0.5)
  } else if (kind === 'supernova') {
    // A shell of torn filaments, red outside and blue-white within, round a faint glow and a pulsar.
    glow(c, half, half, half * 0.7, [
      [0, 'rgba(120,170,255,0.18)'],
      [1, 'rgba(120,170,255,0)']
    ])
    c.lineCap = 'round'
    for (let i = 0; i < 140; i++) {
      const a = r() * Math.PI * 2
      const rad = half * (0.62 + spread(r) * 0.12)
      const len = 0.05 + r() * 0.18
      const outer = r() < 0.6
      c.strokeStyle = outer ? rgba([255, 90 + r() * 60, 90], 0.22 + r() * 0.3) : rgba([140, 200, 255], 0.2 + r() * 0.3)
      c.lineWidth = 0.6 + r() * 1.8
      c.beginPath()
      c.arc(half, half, rad * (outer ? 1 : 0.9), a, a + len)
      c.stroke()
    }
    stars(1, 0, [200, 230, 255])
  } else if (kind === 'planetary') {
    // A ring of glowing gas, teal inside and red at its rim, round the white dwarf it came from.
    const g = c.createRadialGradient(half, half, half * 0.2, half, half, half * 0.85)
    g.addColorStop(0, 'rgba(80,230,220,0.05)')
    g.addColorStop(0.55, 'rgba(80,230,220,0.55)')
    g.addColorStop(0.8, 'rgba(255,90,110,0.45)')
    g.addColorStop(1, 'rgba(255,90,110,0)')
    c.fillStyle = g
    c.beginPath()
    c.ellipse(half, half, half * 0.85, half * (0.6 + r() * 0.25), r() * Math.PI, 0, Math.PI * 2)
    c.fill()
    stars(1, 0, [220, 240, 255])
  } else {
    // A young open cluster: blue-white stars crowding to its middle, in a faint glow.
    glow(c, half, half, half * 0.8, [
      [0, 'rgba(160,190,255,0.16)'],
      [1, 'rgba(160,190,255,0)']
    ])
    stars(55, 0.45, [170, 200, 255])
  }
  if (featureSprites.size > 600) featureSprites.delete(featureSprites.keys().next().value!)
  featureSprites.set(key, sprite)
  return sprite
}

/**
 * The hot gas between a cluster's galaxies: a wide soft glow round its
 * middle, `radius` px.
 */
export function clusterGas(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, seed: number): void {
  const r = rng(seed ^ 0x6a5)
  const tint: Rgb = r() < 0.5 ? [150, 110, 255] : [110, 150, 255]
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  glow(ctx, x, y, radius, [
    [0, rgba(tint, 0.16)],
    [0.45, rgba(tint, 0.06)],
    [1, rgba(tint, 0)]
  ])
  ctx.restore()
}

/** A glowing cloud of gas where stars are being born, pink or teal, in a galaxy seen close up. */
export function starCloud(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, pink: boolean, alpha: number): void {
  const colour: Rgb = pink ? [255, 110, 170] : [90, 200, 220]
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  glow(ctx, x, y, radius, [
    [0, rgba(colour, alpha)],
    [0.5, rgba(colour, alpha * 0.4)],
    [1, rgba(colour, 0)]
  ])
  ctx.restore()
}
