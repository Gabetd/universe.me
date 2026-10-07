import { useEffect } from 'react'
import { focusedNotesEditor } from './components/NotesEditor'
import { Welcome } from './components/Welcome'
import { Workspace } from './components/Workspace'
import { redo, undo, useUi } from './store'

/** True while the user is typing, so app shortcuts leave text editing alone. */
export function isEditingText(): boolean {
  const el = document.activeElement
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)
}

export function App() {
  const ready = useUi((s) => s.ready)
  const hasProject = useUi((s) => s.project !== null)

  useEffect(() => {
    const { apply } = useUi.getState()
    void window.universe.getState().then(apply)
    const offState = window.universe.onState(apply)
    const offMenu = window.universe.onMenu((action) => {
      // Rich-text notes keep their own history; the menu shortcut would otherwise bypass it.
      if (focusedNotesEditor) {
        focusedNotesEditor.commands[action]()
        return
      }
      if (isEditingText()) {
        // Let the focused field undo its own typing.
        document.execCommand(action)
        return
      }
      void (action === 'undo' ? undo() : redo())
    })
    return () => {
      offState()
      offMenu()
    }
  }, [])

  if (!ready) return null
  return hasProject ? <Workspace /> : <Welcome />
}
