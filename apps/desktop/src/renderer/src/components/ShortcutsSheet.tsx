import { SHORTCUTS, useShortcutSheet, type Shortcut } from '../shortcuts'
import { Modal } from './Modal'

const GROUPS: Shortcut['group'][] = ['General', 'World views', 'World tools', 'On the ground', 'Timeline']

/** Every keyboard shortcut, from the table that runs them (`?`, or Help → Keyboard Shortcuts). */
export function ShortcutsSheet() {
  const open = useShortcutSheet((s) => s.open)
  if (!open) return null
  return (
    <Modal title="Keyboard shortcuts" closeLabel="Close keyboard shortcuts" className="shortcuts-sheet" onClose={close} alsoKey="?">
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
    </Modal>
  )
}

const close = () => useShortcutSheet.getState().set(false)
