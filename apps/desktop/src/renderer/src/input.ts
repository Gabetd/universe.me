import type { MenuAction } from '../../shared/api'
import { redo, undo } from './store'

/** True while the user is typing, so app shortcuts leave text editing alone. */
export function isEditingText(): boolean {
  const el = document.activeElement
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)
}

/**
 * Edit → Undo/Redo is first offered to the focused element as this event, so
 * editors with their own history (rich-text notes) can claim it with
 * preventDefault. Unclaimed, plain text fields undo their typing, and
 * anything else undoes the last project change.
 */
export const HISTORY_EVENT = 'universe:history'

export function routeHistory(action: MenuAction): void {
  const target = document.activeElement ?? document.body
  if (!target.dispatchEvent(new CustomEvent<MenuAction>(HISTORY_EVENT, { detail: action, bubbles: true, cancelable: true }))) return
  if (isEditingText()) document.execCommand(action)
  else void (action === 'undo' ? undo() : redo())
}
