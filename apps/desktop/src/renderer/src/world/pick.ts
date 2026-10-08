import type { ThreeEvent } from '@react-three/fiber'
import type { Vec3 } from '@universe/procgen'
import { useMemo } from 'react'
import { openElementMenu, type ElementKind } from '../contextMenu'
import { useEditor } from './editorStore'

/*
 * Handlers given to the 3D views' objects keep their identity while what they
 * call does: a new one counts as a change to the object, which draws a frame.
 */

/**
 * Handlers for the thing `id` (of kind `kind`) in a 3D view, a pin, a
 * structure or a character, to spread on its object: the left button picks it
 * while navigating (with a tool active, the press goes to the tool instead),
 * and the right button gives its options.
 */
export function usePick(onPick: (id: string) => void, id: string, kind: ElementKind) {
  return useMemo(
    () => ({
      onPointerDown: (e: ThreeEvent<PointerEvent>) => {
        if (e.button !== 0 || useEditor.getState().tool !== 'navigate') return
        e.stopPropagation()
        onPick(id)
      },
      onContextMenu: (e: ThreeEvent<MouseEvent>) => {
        // The nearest object only, and the page's own menu doesn't open as well.
        e.stopPropagation()
        e.nativeEvent.preventDefault()
        openElementMenu({ kind, id }, e.nativeEvent.clientX, e.nativeEvent.clientY)
      }
    }),
    [onPick, id, kind]
  )
}

/** For objects that aren't picked: clicks go through to what's behind. */
export const noRaycast = () => null

/**
 * A pointer-down handler for a view's terrain: a left press goes to the tool,
 * at the point `toDir` finds under it; when the tool takes it, the view
 * doesn't turn or pan too.
 */
export const toolPress = (toDir: (e: ThreeEvent<PointerEvent>) => Vec3, onPointerDown: (dir: Vec3) => boolean) => (e: ThreeEvent<PointerEvent>) => {
  if (e.button === 0 && onPointerDown(toDir(e))) e.stopPropagation()
}
