import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'

/**
 * Dialogs and menus over the app, one stack of them in the order they opened
 * (PLAN.md §9, M21): the latest is in front, and Escape (or a dialog's own
 * key) closes it alone, heard before anything else's Escape (which would
 * deselect, or go up a level).
 */

interface Layer {
  close(): void
  alsoKey?: string
}

const stack: Layer[] = []
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((l) => l())
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener))

/** The z-index of the lowest layer; each one opened after it is a step higher. */
const BASE_Z = 100

window.addEventListener(
  'keydown',
  (e) => {
    const top = stack.at(-1)
    if (!top || (e.key !== 'Escape' && e.key !== top.alsoKey)) return
    e.preventDefault()
    e.stopPropagation()
    top.close()
  },
  true
)

/**
 * A dialog or menu, while it's open (`open`): joins the stack, and gives the
 * z-index it shows at, in front of those opened before it. `close` is what
 * Escape (or `alsoKey`) does while it's on top.
 */
export function useLayer(open: boolean, close: () => void, alsoKey?: string): number {
  const latest = useRef({ close, alsoKey })
  useLayoutEffect(() => {
    latest.current = { close, alsoKey }
  })
  const [layer] = useState<Layer>(() => ({
    close: () => latest.current.close(),
    get alsoKey() {
      return latest.current.alsoKey
    }
  }))
  useLayoutEffect(() => {
    if (!open) return
    stack.push(layer)
    changed()
    return () => {
      stack.splice(stack.indexOf(layer), 1)
      changed()
    }
  }, [open, layer])
  const at = useSyncExternalStore(subscribe, () => stack.indexOf(layer))
  return BASE_Z + Math.max(0, at)
}

/** How many dialogs and menus are open: for tests. */
export const openLayers = () => stack.length
