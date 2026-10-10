import type { MenuAction } from '../../shared/api'
import { redo, undo } from './store'

/** True while the user is typing, or working in a menu, so app shortcuts leave the keys alone. */
export function isEditingText(): boolean {
  const el = document.activeElement
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && (el.isContentEditable || !!el.closest('[role="menu"]')))
}

/**
 * Edit → Undo/Redo is first offered to the focused element as this event, so
 * editors with their own history (rich-text notes) can claim it with
 * preventDefault. Unclaimed, plain text fields undo their typing, and
 * anything else undoes the last project change.
 */
export const HISTORY_EVENT = 'universe:history'

/** The menu's history actions, which go to whatever has focus. */
export type HistoryAction = Extract<MenuAction, 'undo' | 'redo'>

export function routeHistory(action: HistoryAction): void {
  const target = document.activeElement ?? document.body
  if (!target.dispatchEvent(new CustomEvent<HistoryAction>(HISTORY_EVENT, { detail: action, bubbles: true, cancelable: true }))) return
  if (isEditingText()) document.execCommand(action)
  else void (action === 'undo' ? undo() : redo())
}
