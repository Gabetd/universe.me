import { useEffect, type ReactNode } from 'react'
import { create } from 'zustand'

export interface DialogState {
  open: boolean
  set(open: boolean): void
}

/** Whether a dialog is open: a store of its own, so menus and buttons anywhere can open it. */
export const dialogStore = () => create<DialogState>((set) => ({ open: false, set: (open) => set({ open }) }))

/**
 * A dialog over the app, closed by its ✕, a click outside it, or Escape
 * (`alsoKey` too), heard before anything else's Escape (which would deselect,
 * or go up a level).
 */
export function Modal({ title, closeLabel, className, onClose, alsoKey, children }: { title: string; closeLabel: string; className: string; onClose(): void; alsoKey?: string; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== alsoKey) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, alsoKey])
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className}`} role="dialog" aria-label={title}>
        <header className="shortcuts-header">
          <h2>{title}</h2>
          <button className="icon" aria-label={closeLabel} onClick={onClose}>
            ✕
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}
