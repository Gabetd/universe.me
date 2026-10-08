import type { SpatialNode, WorldInfo } from '@universe/core'
import { renderEquirect } from '@universe/procgen'
import { useEffect, useState } from 'react'
import { useUi } from '../store'
import { loadTerrain } from '../world/terrainSource'
import { useWorldClimates } from '../world/useSky'

/** A world's surface as a small equirectangular image, for drawing its planet from orbit. */
export interface PlanetTexture {
  pixels: Uint8ClampedArray
  width: number
  height: number
}

const TEX_W = 256
const TEX_H = 128

/**
 * Surface textures for the given worlds, redrawn whenever one of them changes
 * (sculpting, painting, new settings). Terrain is generated in the worker.
 */
export function usePlanetTextures(worlds: SpatialNode[]): Map<string, PlanetTexture> {
  const infos = useUi((s) => s.worlds)
  const climates = useWorldClimates(worlds.map((w) => w.id))
  const [textures, setTextures] = useState(() => new Map<string, PlanetTexture>())
  const wanted = worlds.map((w) => [w, infos.find((i) => i.id === w.id)] as const).filter((p): p is [SpatialNode, WorldInfo] => !!p[1])
  // One key per world's current state: a new settings object or terrain revision redraws it.
  const climateKey = (id: string) => {
    const c = climates.get(id)
    return c ? `${c.offsetC.toFixed(2)}:${c.gradient.toFixed(3)}` : ''
  }
  const key = wanted.map(([w, info]) => `${w.id}:${w.seed}:${info.terrainRevision}:${settingsVersion(info)}:${climateKey(w.id)}`).join('|')

  useEffect(() => {
    let cancelled = false
    void Promise.all(
      wanted.map(async ([node, info]) => {
        const model = await loadTerrain(info, node.seed, climates.get(node.id))
        const pixels = new Uint8ClampedArray(TEX_W * TEX_H * 4)
        renderEquirect(model, pixels, TEX_W, TEX_H)
        return [node.id, { pixels, width: TEX_W, height: TEX_H }] as const
      })
    )
      .then((list) => !cancelled && setTextures(new Map(list)))
      // A world that can't load just keeps its plain look.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `wanted`
  }, [key])
  return textures
}

const versions = new WeakMap<object, number>()
let nextVersion = 0
/** A number that changes whenever a world gets a new settings object (every settings edit makes one). */
function settingsVersion(info: WorldInfo): number {
  let v = versions.get(info.settings)
  if (v === undefined) versions.set(info.settings, (v = ++nextVersion))
  return v
}

interface SphereLut {
  canvas: HTMLCanvasElement
  image: ImageData
  /** Per lit pixel inside the disc: where it lands, its texture row, longitude (0–1) and light. */
  dst: Int32Array
  row: Int32Array
  lon: Float32Array
  shade: Float32Array
}

const luts = new Map<string, SphereLut>()
/** The camera looks down on the equator from this far above it. */
const TILT = 0.38
/** Light from the upper left, a little in front. */
const DEFAULT_LIGHT = Math.atan2(0.45, -0.55)
const LIGHT_STEPS = 48

/** Light coming from `angle` on screen (radians, counter-clockwise from the right), slightly from in front so the near side never goes fully dark. */
const lightFrom = (angle: number) => normalize([Math.cos(angle) * 0.8, Math.sin(angle) * 0.8, 0.45])

/** Works out, once per size and light direction, which point of the sphere each pixel of the disc shows and how lit it is. */
function sphereLut(size: number, texH: number, lightStep: number): SphereLut {
  const key = `${size}:${texH}:${lightStep}`
  const cached = luts.get(key)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const image = new ImageData(size, size)
  const dst: number[] = []
  const row: number[] = []
  const lon: number[] = []
  const shade: number[] = []
  const r = size / 2
  const [c, s] = [Math.cos(TILT), Math.sin(TILT)]
  const LIGHT = lightFrom((lightStep / LIGHT_STEPS) * Math.PI * 2)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const nx = (px + 0.5 - r) / r
      const ny = -(py + 0.5 - r) / r
      const d2 = nx * nx + ny * ny
      if (d2 > 1) continue
      const nz = Math.sqrt(1 - d2)
      // Tip the view so the north pole leans toward the camera.
      const wy = ny * c + nz * s
      const wz = -ny * s + nz * c
      const lat = Math.asin(Math.max(-1, Math.min(1, wy)))
      dst.push((py * size + px) * 4)
      row.push(Math.min(texH - 1, Math.floor((0.5 - lat / Math.PI) * texH)))
      lon.push(Math.atan2(nx, wz) / (2 * Math.PI) + 0.5)
      shade.push(0.16 + 0.95 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]))
    }
  }
  const lut = { canvas, image, dst: Int32Array.from(dst), row: Int32Array.from(row), lon: Float32Array.from(lon), shade: Float32Array.from(shade) }
  // Many sizes and directions come and go as planets move; keep the cache bounded.
  if (luts.size > 400) luts.delete(luts.keys().next().value!)
  luts.set(key, lut)
  return lut
}

/** Draws a globe with a world's real surface, turning (`spin` in turns) and lit from `lightAngle` (radians on screen, toward its star). */
export function drawTexturedPlanet(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, tex: PlanetTexture, spin: number, lightAngle = DEFAULT_LIGHT): void {
  const size = Math.max(4, Math.round(radius * 2))
  const step = ((Math.round((lightAngle / (Math.PI * 2)) * LIGHT_STEPS) % LIGHT_STEPS) + LIGHT_STEPS) % LIGHT_STEPS
  const lut = sphereLut(size, tex.height, step)
  const out = lut.image.data
  const { pixels, width } = tex
  const offset = spin - Math.floor(spin)
  for (let k = 0; k < lut.dst.length; k++) {
    // Turning west to east: the land under each pixel moves on eastward.
    let u = lut.lon[k]! - offset
    if (u < 0) u += 1
    const src = (lut.row[k]! * width + Math.min(width - 1, Math.floor(u * width))) * 4
    const o = lut.dst[k]!
    const l = lut.shade[k]!
    out[o] = pixels[src]! * l
    out[o + 1] = pixels[src + 1]! * l
    out[o + 2] = pixels[src + 2]! * l
    out[o + 3] = 255
  }
  lut.canvas.getContext('2d')!.putImageData(lut.image, 0, 0)
  ctx.drawImage(lut.canvas, x - size / 2, y - size / 2)
  // A thin atmosphere.
  const g = ctx.createRadialGradient(x, y, radius * 0.92, x, y, radius * 1.12)
  g.addColorStop(0, 'rgba(120,170,255,0)')
  g.addColorStop(0.45, 'rgba(120,170,255,0.35)')
  g.addColorStop(1, 'rgba(120,170,255,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, radius * 1.12, 0, Math.PI * 2)
  ctx.fill()
}

function normalize(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(...v)
  return [v[0] / l, v[1] / l, v[2] / l]
}
