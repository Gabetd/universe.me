import { mouthFlow, type River } from '@universe/procgen'

/** How rivers look on every view: one water colour, wider as more water runs in them. */
export const RIVER_COLOR = '#5aa9e6'

/** A river's width on screen, in pixels: a stream at 1, the greatest about 3½. */
export const riverWidth = (r: River) => Math.min(3.5, 0.9 + 0.6 * Math.log2(1 + mouthFlow(r)))

/** A path (of points in any number of dimensions) with its corners cut (Chaikin's, twice), so a river that steps from cell to cell bends instead; its ends stay where they are. */
export function smoothPath<P extends number[]>(path: P[], rounds = 2): P[] {
  const mix = (a: P, b: P, t: number) => a.map((v, i) => v + (b[i]! - v) * t) as P
  let out = path
  for (let n = 0; n < rounds && out.length > 2; n++) {
    const next: P[] = [out[0]!]
    for (let k = 0; k < out.length - 1; k++) next.push(mix(out[k]!, out[k + 1]!, 0.25), mix(out[k]!, out[k + 1]!, 0.75))
    next.push(out.at(-1)!)
    out = next
  }
  return out
}
