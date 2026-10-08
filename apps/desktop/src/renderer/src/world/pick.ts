import type { ThreeEvent } from '@react-three/fiber'
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
