import { useEffect } from 'react'
import { Welcome } from './components/Welcome'
import { Workspace } from './components/Workspace'
import { routeHistory } from './input'
import { useUi } from './store'

export function App() {
  const ready = useUi((s) => s.ready)
  const hasProject = useUi((s) => s.project !== null)

  useEffect(() => {
    const { apply } = useUi.getState()
    void window.universe.getState().then(apply)
    const offState = window.universe.onState(apply)
    const offMenu = window.universe.onMenu(routeHistory)
    return () => {
      offState()
      offMenu()
    }
  }, [])

  if (!ready) return null
  return hasProject ? <Workspace /> : <Welcome />
}
