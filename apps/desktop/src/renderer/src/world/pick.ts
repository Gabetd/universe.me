import type { ThreeEvent } from '@react-three/fiber'
import type { Vec3 } from '@universe/procgen'
import { useMemo } from 'react'
import { useEditor } from './editorStore'

/*
 * Handlers given to the 3D views' objects keep their identity while what they
 * call does: a new one counts as a change to the object, which draws a frame.
 */

/**
 * A pointer-down handler that picks the thing `id` in a 3D view (a pin, a
 * structure, a character) with the left button while navigating; with a tool
 * active, the press goes to the tool instead.
 */
export function usePick(onPick: (id: string) => void, id: string) {
  return useMemo(
    () => (e: ThreeEvent<PointerEvent>) => {
      if (e.button !== 0 || useEditor.getState().tool !== 'navigate') return
      e.stopPropagation()
      onPick(id)
    },
    [onPick, id]
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
