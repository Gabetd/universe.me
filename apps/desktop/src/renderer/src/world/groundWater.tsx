import { TERRAIN_RES, type LatLon } from '@universe/core'
import {
  FALL_M,
  LAKE_SHEET_REACH,
  RIVER_SHEET_PAST_M,
  cellCenter,
  cellPlace,
  chunkBounds,
  chunkOf,
  dirToLatLon,
  faceCellOf,
  faceToDir,
  lakeBasins,
  modelSampler,
  planetCell,
  riverCourses,
  toLocal,
  type GroundWaters,
  type LocalFrame,
  type TerrainModel,
  type WaterCourse
} from '@universe/procgen'
import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { airUniforms, inTheAir } from './groundAir'
import { noRaycast } from './pick'
import { useWater } from './useWater'

/** How far around the view rivers and lakes are worked out for the ground: past the distant ground's edge. */
const WATERS_REACH_M = 30_000
/** The rivers and lakes are worked out again when the view moves into another block of this many chunks a side. */
const WATERS_BLOCK = 4

/** The rivers and lakes around the view, and what they were worked out from (the world's water: the same for every block, so a chunk built for one block is right for the next). */
export interface AreaWaters extends GroundWaters {
  source: object
}

/**
 * The rivers and lakes around the view (`center`) as the ground has them
 * (see `riverCourses`): undefined until the world's water is worked out.
 * Worked out again as the view moves into another block of chunks; what's
 * worked out for a stretch of river is the same whichever block it's for.
 */
export function useGroundWaters(worldId: string, model: TerrainModel, center: LatLon): AreaWaters | undefined {
  const world = useWater(worldId)
  const radiusKm = model.settings.radiusKm
  const here = chunkOf(center, radiusKm)
  const snap = (n: number) => Math.floor(n / WATERS_BLOCK) * WATERS_BLOCK + WATERS_BLOCK / 2
  const block = chunkBounds({ row: snap(here.row), col: snap(here.col) }, radiusKm)
  const key = `${block.lat0},${block.lon0}`
  return useMemo(() => {
    if (!world) return undefined
    const middle = { lat: block.lat0, lon: block.lon0 }
    const courses = riverCourses(world.rivers, modelSampler(model), middle, WATERS_REACH_M, radiusKm)
    const lakes = lakeBasins(world.lakes, middle, WATERS_REACH_M, radiusKm, cellPlace)
    return { courses, lakes, source: world }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the block
  }, [world, model, key, radiusKm])
}

/**
 * Rivers and lakes on the ground: each river a ribbon on its water's surface,
 * as wide as it is, down its course (the land is cut to hold it), with its
 * falls as curtains of white water and foam below them; each lake a sheet at
 * its surface over its cells, reaching a little past them under its raised
 * shore. Curved down with the planet like the land.
 */
export function GroundWater({ waters, color, frame }: { waters: GroundWaters; color: string; frame: LocalFrame }) {
  const material = useMemo(
    () =>
      inTheAir(
        new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.8, roughness: 0.2, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
        { water: true, foam: true }
      ),
    []
  )
  useEffect(() => () => material.dispose(), [material])
  const invalidate = useThree((s) => s.invalidate)
  useLayoutEffect(() => {
    material.color.set(color)
    invalidate()
  }, [material, color, invalidate])
  const geometry = useMemo(() => {
    const positions: number[] = []
    const foams: number[] = []
    const spray: number[] = []
    const vertex = (p: readonly number[], foam: number) => {
      positions.push(p[0]!, p[1]!, p[2]!)
      foams.push(foam)
    }
    for (const course of waters.courses) riverRibbon(course, frame, vertex, (x, y, z, size) => spray.push(x, y, z, size))
    for (const lake of waters.lakes) {
      const cells = new Set(lake.cells)
      for (const g of lake.cells) lakeSheet(g, lake.level, cells, frame, vertex)
    }
    if (!positions.length) return undefined
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setAttribute('foam', new THREE.Float32BufferAttribute(foams, 1))
    g.computeVertexNormals()
    return { water: g, spray: sprayGeometry(spray) }
  }, [waters, frame])
  useEffect(
    () => () => {
      geometry?.water.dispose()
      geometry?.spray.dispose()
    },
    [geometry]
  )
  if (!geometry) return null
  return (
    <>
      <mesh geometry={geometry.water} material={material} raycast={noRaycast} renderOrder={3} />
      <points geometry={geometry.spray} material={SPRAY} raycast={noRaycast} renderOrder={4} />
    </>
  )
}

/** Puffs of spray at a fall's foot, each a soft white blot some metres across, drifting with the wind. */
const SPRAY = (() => {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,0.55)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: new THREE.CanvasTexture(canvas) }, uCloudTime: airUniforms.uCloudTime, scale: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float size;
      uniform float uCloudTime;
      varying float vFade;
      void main() {
        // Each puff rises and fades, and starts again.
        float t = fract(uCloudTime * 0.15 + position.x * 0.013 + position.z * 0.007);
        vec3 p = position + vec3(0.0, t * size * 0.8, 0.0);
        vFade = sin(t * 3.14159);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = size * (1.0 + t) * projectionMatrix[1][1] * 300.0 / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying float vFade;
      void main() { gl_FragColor = texture2D(map, gl_PointCoord) * vec4(1.0, 1.0, 1.0, vFade); }`,
    transparent: true,
    depthWrite: false
  })
  return material
})()

/** The spray's puffs, from [x, y, z, size] in a row. */
function sprayGeometry(spray: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const positions: number[] = []
  const sizes: number[] = []
  for (let k = 0; k < spray.length; k += 4) {
    const [x, y, z, size] = spray.slice(k, k + 4) as [number, number, number, number]
    // A few puffs across the fall's width.
    for (let i = -2; i <= 2; i++) {
      positions.push(x + i * size * 0.35, y, z + ((i * 7) % 5) * size * 0.08)
      sizes.push(size * (0.8 + 0.1 * ((i + 3) % 3)))
    }
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1))
  return g
}

type Vertex = (p: readonly number[], foam: number) => void

/** How far below a fall its foam reaches, in metres. */
const FOAM_M = 60

/** A river's ribbon down its course: two triangles between each point and the next, its falls (a point twice, above and below) standing upright, white, with spray at their feet. */
function riverRibbon(course: WaterCourse, frame: LocalFrame, vertex: Vertex, spray: (x: number, y: number, z: number, size: number) => void): void {
  const pts = course.points.map(([lat, lon, level]) => {
    const [x, z] = toLocal(frame, { lat: lat!, lon: lon! })
    return [x, level! + 0.25, z] as const
  })
  // How white the water is at each point: on a fall, and fading below it; rapids, a little.
  const foam = new Float32Array(pts.length)
  let since = Infinity
  for (let k = 0; k < pts.length; k++) {
    const prev = pts[k - 1]
    if (prev) {
      const run = Math.hypot(pts[k]![0] - prev[0], pts[k]![2] - prev[2])
      const drop = prev[1] - pts[k]![1]
      if (drop > FALL_M * 0.4 && run < 1) {
        since = 0
        spray(pts[k]![0], pts[k]![1], pts[k]![2], Math.min(course.halfWidth, drop * 1.5 + 6))
      } else since += run
      foam[k] = Math.max(since < FOAM_M ? 1 - since / FOAM_M : 0, Math.min(0.6, Math.max(0, drop / Math.max(run, 1)) * 12))
    }
  }
  // Past its banks, under the land rising from it: the water's edge is where the land meets it.
  const half = course.halfWidth + RIVER_SHEET_PAST_M
  // A point's two banks, square to the river there (the way from the point before to the one after, on the level).
  const banks = (k: number) => {
    const [x, y, z] = pts[k]!
    const [px, , pz] = pts[Math.max(0, k - 1)]!
    const [qx, , qz] = pts[Math.min(pts.length - 1, k + 1)]!
    const len = Math.hypot(qx - px, qz - pz) || 1
    const [nx, nz] = [(-(qz - pz) / len) * half, ((qx - px) / len) * half]
    return [
      [x + nx, y, z + nz],
      [x - nx, y, z - nz]
    ] as const
  }
  for (let k = 0; k < pts.length - 1; k++) {
    const [a, b] = [banks(k), banks(k + 1)]
    const [fa, fb] = [foam[k]!, foam[k + 1]!]
    // On a fall both ends are white.
    const fall = pts[k]![1] - pts[k + 1]![1] > FALL_M * 0.4 ? 1 : 0
    const [ta, tb] = [Math.max(fa, fall), Math.max(fb, fall)]
    for (const [p, foam] of [[a[0], ta], [a[1], ta], [b[1], tb], [a[0], ta], [b[1], tb], [b[0], tb]] as const) vertex(p, foam)
  }
}

/** The corners of a cell, a half cell from its centre each way, and which neighbour each side faces: [di, dj] per corner. */
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1]
] as const

/** A lake's water over one of its cells (a planet-wide number), at its surface: reaching under the shore on the sides where it meets land. */
function lakeSheet(g: number, level: number, cells: ReadonlySet<number>, frame: LocalFrame, vertex: Vertex): void {
  const [face, cell] = faceCellOf(g)
  const [i, j] = [cell % TERRAIN_RES, Math.floor(cell / TERRAIN_RES)]
  const land = (di: number, dj: number) => {
    const [ni, nj] = [i + di, j + dj]
    return ni < 0 || nj < 0 || ni >= TERRAIN_RES || nj >= TERRAIN_RES || !cells.has(planetCell(face, nj * TERRAIN_RES + ni))
  }
  // A cell's width in face coordinates, and the reach past it as a share of that.
  const cellM = ((Math.PI / 2) * frame.radiusKm * 1000) / TERRAIN_RES
  const reach = LAKE_SHEET_REACH / cellM
  const [a, b, c, d] = CORNERS.map(([di, dj]) => {
    const [ei, ej] = [di * (1 + (land(di, 0) ? reach * 2 : 0)), dj * (1 + (land(0, dj) ? reach * 2 : 0))]
    const [x, z] = toLocal(frame, dirToLatLon(...faceToDir(face, cellCenter(i) + ei / TERRAIN_RES, cellCenter(j) + ej / TERRAIN_RES)))
    return [x, level, z]
  })
  for (const p of [a, b, c, a, c, d]) vertex(p!, 0)
}
