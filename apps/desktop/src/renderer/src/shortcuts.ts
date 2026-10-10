import { useEffect, useLayoutEffect, useRef } from 'react'
import { create } from 'zustand'
import { isEditingText } from './input'

/**
 * The app's keyboard shortcuts, in one table: the keys that run them, and
 * the shortcuts sheet (`?`) that lists them. Single keys work while nothing
 * that takes typing has focus. What a key does depends on what's on screen,
 * so the parts that do it register their action while they're shown
 * (`useShortcuts`); keys the menu or other handlers already answer are listed
 * here too (without `key`), so the sheet has them all.
 */
export interface Shortcut {
  id: string
  /** As the sheet shows it. */
  keys: string
  /** The `KeyboardEvent.key` it answers to (letters in either case); none for keys answered elsewhere. */
  key?: string
  label: string
  group: 'General' | 'World views' | 'World tools' | 'Timeline'
}

const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+'

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'shortcuts', keys: '?', key: '?', label: 'Show these shortcuts', group: 'General' },
  { id: 'undo', keys: `${mod}Z`, label: 'Undo', group: 'General' },
  { id: 'redo', keys: navigator.platform.startsWith('Mac') ? '⌘⇧Z' : 'Ctrl+Y', label: 'Redo', group: 'General' },
  { id: 'delete', keys: 'Delete', label: 'Delete what’s selected', group: 'General' },
  { id: 'escape', keys: 'Esc', label: 'Cancel a tool, deselect, or go up a level', group: 'General' },
  { id: 'new', keys: `${mod}N`, label: 'New universe', group: 'General' },
  { id: 'open', keys: `${mod}O`, label: 'Open a universe', group: 'General' },

  { id: 'view-globe', keys: '1', key: '1', label: 'Globe', group: 'World views' },
  { id: 'view-map', keys: '2', key: '2', label: 'Map', group: 'World views' },
  { id: 'view-ground', keys: '3', key: '3', label: 'Ground', group: 'World views' },
  { id: 'view-canvas', keys: '4', key: '4', label: 'Canvas', group: 'World views' },
  { id: 'view-species', keys: '5', key: '5', label: 'Species', group: 'World views' },
  { id: 'view-powers', keys: '6', key: '6', label: 'Powers', group: 'World views' },
  { id: 'view-factions', keys: '7', key: '7', label: 'Factions', group: 'World views' },
  { id: 'view-warnings', keys: '8', key: '8', label: 'Warnings', group: 'World views' },

  { id: 'tool-navigate', keys: 'H', key: 'h', label: 'Navigate', group: 'World tools' },
  { id: 'tool-raise', keys: 'R', key: 'r', label: 'Raise land', group: 'World tools' },
  { id: 'tool-lower', keys: 'L', key: 'l', label: 'Lower land', group: 'World tools' },
  { id: 'tool-smooth', keys: 'S', key: 's', label: 'Smooth', group: 'World tools' },
  { id: 'tool-flatten', keys: 'F', key: 'f', label: 'Flatten', group: 'World tools' },
  { id: 'tool-paint', keys: 'B', key: 'b', label: 'Paint biome', group: 'World tools' },
  { id: 'tool-erase', keys: 'E', key: 'e', label: 'Erase biome', group: 'World tools' },
  { id: 'tool-region', keys: 'G', key: 'g', label: 'Draw region', group: 'World tools' },
  { id: 'tool-place', keys: 'P', key: 'p', label: 'Place structure', group: 'World tools' },

  { id: 'new-event', keys: 'N', key: 'n', label: 'New event at the playhead', group: 'Timeline' },
  { id: 'prev-event', keys: '[', key: '[', label: 'Playhead to the event before', group: 'Timeline' },
  { id: 'next-event', keys: ']', key: ']', label: 'Playhead to the event after', group: 'Timeline' },
  { id: 'fit', keys: '0', key: '0', label: 'Fit the timeline to everything on it', group: 'Timeline' }
]

const byId = new Map(SHORTCUTS.map((s) => [s.id, s]))

/** A control's tooltip with its shortcut: "Raise land (R)". */
export function withKey(title: string, id: string): string {
  const s = byId.get(id)
  return s ? `${title} (${s.keys})` : title
}

/** What each shortcut does now, as registered by what's on screen. */
const actions = new Map<string, () => void>()

/** While mounted, these shortcuts (by id) run these actions; the latest ones given are the ones run. */
export function useShortcuts(handlers: Record<string, () => void>): void {
  const latest = useRef(handlers)
  useLayoutEffect(() => {
    latest.current = handlers
  })
  const ids = Object.keys(handlers).sort().join()
  useEffect(() => {
    const own = ids ? ids.split(',') : []
    const runs = own.map((id) => [id, () => latest.current[id]?.()] as const)
    for (const [id, run] of runs) actions.set(id, run)
    return () => {
      for (const [id, run] of runs) if (actions.get(id) === run) actions.delete(id)
    }
  }, [ids])
}

/** Runs the shortcut a key press is for, if one is registered. Installed once, by the app. */
export function onShortcutKey(e: KeyboardEvent): void {
  // Not while typing, nor behind a dialog (the shortcuts sheet closes itself).
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditingText() || document.querySelector('.modal-backdrop')) return
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const shortcut = SHORTCUTS.find((s) => s.key === key)
  const run = shortcut && actions.get(shortcut.id)
  if (!run) return
  e.preventDefault()
  run()
}

/** Whether the shortcuts sheet is open. */
export const useShortcutSheet = create<{ open: boolean; set(open: boolean): void }>((set) => ({ open: false, set: (open) => set({ open }) }))
