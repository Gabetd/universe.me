import { useEffect } from 'react'
import { ShortcutsSheet } from './components/ShortcutsSheet'
import { UpdateBanner } from './components/UpdateBanner'
import { Welcome } from './components/Welcome'
import { Workspace } from './components/Workspace'
import { routeHistory } from './input'
import { onShortcutKey, useShortcutSheet, useShortcuts } from './shortcuts'
import { isPhoneApp } from './webBridge'
import { useUi } from './store'

const showShortcuts = () => useShortcutSheet.getState().set(true)

export function App() {
  const ready = useUi((s) => s.ready)
  const hasProject = useUi((s) => s.project !== null)
  useShortcuts({ shortcuts: showShortcuts })

  useEffect(() => {
    const { apply } = useUi.getState()
    void window.universe.getState().then(apply)
    const offState = window.universe.onState(apply)
    const offMenu = window.universe.onMenu((action) => (action === 'shortcuts' ? showShortcuts() : routeHistory(action)))
    window.addEventListener('keydown', onShortcutKey)
    return () => {
      offState()
      offMenu()
      window.removeEventListener('keydown', onShortcutKey)
    }
  }, [])

  if (!ready) return null
  return (
    <div className="app-shell">
      {!isPhoneApp() && <UpdateBanner />}
      <div className="app-main">{hasProject ? <Workspace /> : isPhoneApp() ? <NothingOpen /> : <Welcome />}</div>
      <ShortcutsSheet />
    </div>
  )
}

/** The phone app with no project open on the computer: what's open there shows here. */
function NothingOpen() {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <header className="welcome-hero">
          <h1>Universe</h1>
          <p>Open a universe on your computer, and it shows here.</p>
        </header>
      </div>
    </div>
  )
}
