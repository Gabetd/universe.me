import type { ReactNode } from 'react'
import { useLayer } from '../layers'
import { create } from 'zustand'

export interface DialogState {
  open: boolean
  set(open: boolean): void
}

/** Whether a dialog is open: a store of its own, so menus and buttons anywhere can open it. */
export const dialogStore = () => create<DialogState>((set) => ({ open: false, set: (open) => set({ open }) }))

/**
 * A dialog over the app, closed by its ✕, a click outside it, or Escape
 * (`alsoKey` too) while it's the latest dialog or menu open (layers.ts): one
 * opened over it, a right-click menu too, is in front, and closed first.
 */
export function Modal({ title, closeLabel, className, onClose, alsoKey, children }: { title: string; closeLabel: string; className: string; onClose(): void; alsoKey?: string; children: ReactNode }) {
  const zIndex = useLayer(true, onClose, alsoKey)
  return (
    <div className="modal-backdrop" style={{ zIndex }} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
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
