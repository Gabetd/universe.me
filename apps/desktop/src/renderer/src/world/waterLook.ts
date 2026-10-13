import { waterwayKind } from '@universe/core'
import { mouthFlow, waterwayPlace, type Lake, type River } from '@universe/procgen'
import { useEditor } from './editorStore'

/** What a river or lake (by its id) is called as a kind of thing. */
export const waterwayLabel = (key: string) => (waterwayKind(key) === 'lake' ? 'Lake' : 'River')

/** How rivers look on every view: one water colour, wider as more water runs in them. */
export const RIVER_COLOR = '#5aa9e6'

/** A river's width on screen, in pixels: a stream at 1, the greatest about 3½. */
export const riverWidth = (r: River) => Math.min(3.5, 0.9 + 0.6 * Math.log2(1 + mouthFlow(r)))

export { riverMetres, smoothPath } from '@universe/procgen'

/** How far from the ground's middle the camera starts when going to see water: far enough to see a river's width. */
const VIEW_FROM_M = 1500

/** Goes down to the ground at a river or lake: a river's middle, a lake's deepest point. */
export const viewUpClose = (w: River | Lake) => useEditor.getState().enterGround(waterwayPlace(w), VIEW_FROM_M)
