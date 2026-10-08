import type { Plant } from '@universe/procgen'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * Low-poly plants and rocks for the ground view, each about 1 unit tall (or
 * across) with its base at y = 0, coloured per vertex: bark stays brown while
 * leaves take the world's vegetation colour.
 */

const BARK = new THREE.Color('#6b4a2f')
const DRY_WOOD = new THREE.Color('#8a7b68')
const ROCK = new THREE.Color('#8d8a84')
const CACTUS = new THREE.Color('#5b8a4a')
const REED = new THREE.Color('#9a9a58')

function painted(geometry: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  g.deleteAttribute('uv')
  const count = g.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) color.toArray(colors, i * 3)
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return g
}

const trunk = (height: number, radius: number, color = BARK) => painted(new THREE.CylinderGeometry(radius * 0.7, radius, height, 6).translate(0, height / 2, 0), color)

/** Shades of a colour, so a wood isn't one flat green. */
const shade = (c: THREE.Color, f: number) => c.clone().multiplyScalar(f)

export function plantGeometry(plant: Plant, foliage: THREE.Color): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  switch (plant) {
    case 'broadleaf':
      parts.push(trunk(0.45, 0.045))
      parts.push(painted(new THREE.IcosahedronGeometry(0.3, 0).scale(1, 0.85, 1).translate(0, 0.66, 0), foliage))
      break
    case 'conifer': {
      const dark = shade(foliage, 0.62)
      parts.push(trunk(0.22, 0.035))
      parts.push(painted(new THREE.ConeGeometry(0.22, 0.5, 7).translate(0, 0.42, 0), dark))
      parts.push(painted(new THREE.ConeGeometry(0.16, 0.42, 7).translate(0, 0.72, 0), shade(dark, 1.12)))
      break
    }
    case 'palm':
      parts.push(painted(new THREE.CylinderGeometry(0.025, 0.04, 0.86, 5).translate(0, 0.43, 0).rotateZ(0.08), BARK))
      parts.push(painted(new THREE.ConeGeometry(0.42, 0.16, 7, 1, true).rotateX(Math.PI).translate(0.03, 0.9, 0), shade(foliage, 1.05)))
      break
    case 'acacia':
      parts.push(trunk(0.6, 0.04))
      parts.push(painted(new THREE.CylinderGeometry(0.5, 0.38, 0.12, 8).translate(0, 0.66, 0), shade(foliage, 0.9)))
      break
    case 'bush':
      parts.push(painted(new THREE.IcosahedronGeometry(0.5, 0).scale(1, 0.75, 1).translate(0, 0.36, 0), shade(foliage, 0.8)))
      break
    case 'grass':
      for (let k = 0; k < 3; k++) {
        parts.push(painted(new THREE.ConeGeometry(0.07, 1, 3).translate(0, 0.5, 0).rotateZ(0.25).rotateY((k * Math.PI * 2) / 3), shade(foliage, 1.1 + k * 0.05)))
      }
      break
    case 'flower':
      parts.push(painted(new THREE.CylinderGeometry(0.02, 0.02, 0.8, 3).translate(0, 0.4, 0), foliage))
      // White petals: each flower's own colour comes from its instance colour.
      parts.push(painted(new THREE.IcosahedronGeometry(0.16, 0).translate(0, 0.86, 0), new THREE.Color('#ffffff')))
      break
    case 'cactus':
      parts.push(painted(new THREE.CylinderGeometry(0.11, 0.12, 1, 8).translate(0, 0.5, 0), CACTUS))
      parts.push(painted(new THREE.CylinderGeometry(0.06, 0.06, 0.35, 6).translate(0.18, 0.62, 0), CACTUS))
      parts.push(painted(new THREE.CylinderGeometry(0.05, 0.05, 0.25, 6).translate(-0.16, 0.5, 0), CACTUS))
      break
    case 'rock':
      parts.push(painted(new THREE.DodecahedronGeometry(0.5, 0).scale(1, 0.6, 0.85).translate(0, 0.12, 0), ROCK))
      break
    case 'reed':
      for (let k = 0; k < 4; k++) parts.push(painted(new THREE.CylinderGeometry(0.012, 0.02, 1, 3).translate(0, 0.5, 0).rotateZ((k - 1.5) * 0.12).translate(k * 0.04 - 0.06, 0, (k % 2) * 0.05), REED))
      break
    case 'snag':
      parts.push(trunk(1, 0.05, DRY_WOOD))
      parts.push(painted(new THREE.CylinderGeometry(0.015, 0.025, 0.4, 4).translate(0, 0.2, 0).rotateZ(0.9).translate(0.02, 0.6, 0), DRY_WOOD))
      break
  }
  const merged = mergeGeometries(parts)!
  merged.computeVertexNormals()
  merged.computeBoundingSphere()
  return merged
}

/** Plants close to the camera only: tiny ones aren't worth drawing farther out. */
export const NEAR_ONLY: Plant[] = ['grass', 'flower', 'reed']

const FLOWER_COLORS = ['#f2d14b', '#e8577a', '#f4f1ea', '#9c6ce0', '#ef8a3a'].map((c) => new THREE.Color(c))

/** The colour an instance's `tint` (0–1) gives it: a little lighter or darker, and a petal colour for flowers. */
export function instanceTint(plant: Plant, tint: number, out: THREE.Color): THREE.Color {
  if (plant === 'flower') return out.copy(FLOWER_COLORS[Math.floor(tint * FLOWER_COLORS.length) % FLOWER_COLORS.length]!)
  const f = 0.82 + tint * 0.32
  return out.setRGB(f, f, f)
}
