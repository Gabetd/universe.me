import type { ThreeEvent } from '@react-three/fiber'
import type { Vec3 } from '@universe/procgen'
import { useEditor } from './editorStore'

/**
 * A pointer-down handler that picks something in a 3D view (a pin, a
 * structure, a character) with the left button while navigating; with a tool
 * active, the press goes to the tool instead.
 */
export const pickWith = (onPick: () => void) => (e: ThreeEvent<PointerEvent>) => {
  if (e.button !== 0 || useEditor.getState().tool !== 'navigate') return
  e.stopPropagation()
  onPick()
}

/**
 * A pointer-down handler for a view's terrain: a left press goes to the tool,
 * at the point `toDir` finds under it; when the tool takes it, the view
 * doesn't turn or pan too.
 */
export const toolPress = (toDir: (e: ThreeEvent<PointerEvent>) => Vec3, onPointerDown: (dir: Vec3) => boolean) => (e: ThreeEvent<PointerEvent>) => {
  if (e.button === 0 && onPointerDown(toDir(e))) e.stopPropagation()
}
