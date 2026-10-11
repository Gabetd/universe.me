import { waterwayKind } from '@universe/core'
import { mouthFlow, waterwayPlace, type Lake, type River } from '@universe/procgen'
import { useEditor } from './editorStore'

/** What a river or lake (by its id) is called as a kind of thing. */
export const waterwayLabel = (key: string) => (waterwayKind(key) === 'lake' ? 'Lake' : 'River')

/** How rivers look on every view: one water colour, wider as more water runs in them. */
export const RIVER_COLOR = '#5aa9e6'

/** A river's width on screen, in pixels: a stream at 1, the greatest about 3½. */
export const riverWidth = (r: River) => Math.min(3.5, 0.9 + 0.6 * Math.log2(1 + mouthFlow(r)))

/** A river's width on the ground, in metres: a stream sixty or so, the greatest some three hundred. */
export const riverMetres = (r: River) => Math.min(320, 40 + 55 * Math.log2(1 + mouthFlow(r)))

/**
 * A path (of points in any number of dimensions) drawn as a curve through
 * each of its points (Catmull-Rom, `steps` pieces between each two), so a
 * river that steps from cell to cell bends instead, and still passes through
 * the cells where its tributaries join it.
 */
export function smoothPath<P extends number[]>(path: P[], steps = 4): P[] {
  if (path.length < 3) return path
  const out: P[] = []
  for (let k = 0; k < path.length - 1; k++) {
    const [p0, p1, p2, p3] = [path[Math.max(0, k - 1)]!, path[k]!, path[k + 1]!, path[Math.min(path.length - 1, k + 2)]!]
    for (let i = 0; i < steps; i++) {
      const t = i / steps
      const [t2, t3] = [t * t, t * t * t]
      out.push(p1.map((v, d) => 0.5 * (2 * v + (-p0[d]! + p2[d]!) * t + (2 * p0[d]! - 5 * v + 4 * p2[d]! - p3[d]!) * t2 + (-p0[d]! + 3 * v - 3 * p2[d]! + p3[d]!) * t3)) as P)
    }
  }
  out.push(path.at(-1)!)
  return out
}

/** How far from the ground's middle the camera starts when going to see water: far enough to see a river's width. */
const VIEW_FROM_M = 1500

/** Goes down to the ground at a river or lake: a river's middle, a lake's deepest point. */
export const viewUpClose = (w: River | Lake) => useEditor.getState().enterGround(waterwayPlace(w), VIEW_FROM_M)
