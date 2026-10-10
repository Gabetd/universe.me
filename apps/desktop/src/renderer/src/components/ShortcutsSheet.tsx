import { useEffect } from 'react'
import { SHORTCUTS, useShortcutSheet, type Shortcut } from '../shortcuts'

const GROUPS: Shortcut['group'][] = ['General', 'World views', 'World tools', 'Timeline']

/** Every keyboard shortcut, from the table that runs them (`?`, or Help → Keyboard Shortcuts). */
export function ShortcutsSheet() {
  const { open, set } = useShortcutSheet()
  useEffect(() => {
    if (!open) return
    // Before anything else's Escape (which would deselect, or go up a level).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== '?') return
      e.preventDefault()
      e.stopPropagation()
      set(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, set])
  if (!open) return null
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && set(false)}>
      <div className="modal shortcuts-sheet" role="dialog" aria-label="Keyboard shortcuts">
        <header className="shortcuts-header">
          <h2>Keyboard shortcuts</h2>
          <button className="icon" aria-label="Close keyboard shortcuts" onClick={() => set(false)}>
            ✕
          </button>
        </header>
        <div className="shortcuts-groups">
          {GROUPS.map((group) => (
            <section key={group} aria-label={group}>
              <h3>{group}</h3>
              <dl>
                {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                  <div key={s.id} className="shortcut-row">
                    <dt>
                      <kbd>{s.keys}</kbd>
                    </dt>
                    <dd>{s.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="muted small">Single keys work while you’re not typing in a field. World keys work with a world open; tools on the globe, the map and the ground.</p>
      </div>
    </div>
  )
}
