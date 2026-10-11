import { create } from 'zustand'

/** How the canvas behaves, as its toolbar sets it: snapping, and whether it's read-only. Kept for the next time, on this computer. */
interface CanvasSettings {
  snapGrid: boolean
  snapObjects: boolean
  readOnly: boolean
  toggle(key: 'snapGrid' | 'snapObjects' | 'readOnly'): void
}

const KEY = 'universe.canvas'

function load(): Partial<CanvasSettings> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<CanvasSettings>
  } catch {
    return {}
  }
}

export const useCanvasSettings = create<CanvasSettings>((set, get) => ({
  snapGrid: false,
  snapObjects: true,
  readOnly: false,
  ...load(),
  toggle: (key) => {
    set({ [key]: !get()[key] })
    const { snapGrid, snapObjects, readOnly } = get()
    try {
      localStorage.setItem(KEY, JSON.stringify({ snapGrid, snapObjects, readOnly }))
    } catch {
      // Kept for this session only.
    }
  }
}))
