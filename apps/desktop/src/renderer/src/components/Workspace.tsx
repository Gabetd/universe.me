import { ancestry } from '@universe/core'
import { useEffect } from 'react'
import { isEditingText } from '../App'
import { KIND_ICONS } from '../kinds'
import { redo, selectNode, undo, useUi } from '../store'
import { ErrorBanner } from './ErrorBanner'
import { Inspector } from './Inspector'
import { Outline } from './Outline'
import { TimelineBar } from './TimelineBar'
import { Viewport } from './Viewport'

export function Workspace() {
  const nodes = useUi((s) => s.nodes)
  const selected = useUi(selectNode)
  const canUndo = useUi((s) => s.canUndo)
  const canRedo = useUi((s) => s.canRedo)
  const project = useUi((s) => s.project)!
  const select = useUi((s) => s.select)
  const path = selected ? ancestry(nodes, selected.id) : []

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditingText()) return
      const { selectedId, project: p, execute, nodes: all } = useUi.getState()
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && selectedId !== p?.rootId) {
        e.preventDefault()
        void execute({ type: 'node.delete', payload: { id: selectedId } })
      }
      if (e.key === 'Escape' && selectedId) {
        // Escape zooms out one level, like the scroll wheel in the viewport.
        const parent = all.find((n) => n.id === selectedId)?.parentId
        if (parent) useUi.getState().select(parent)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="workspace">
      <header className="topbar">
        <nav className="breadcrumb" aria-label="Location">
          {path.map((n, i) => (
            <span key={n.id} className="crumb">
              {i > 0 && <span className="crumb-sep">›</span>}
              <button className="link" onClick={() => select(n.id)} aria-current={i === path.length - 1}>
                <span className="crumb-icon">{KIND_ICONS[n.kind]}</span>
                {n.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="topbar-actions">
          <button onClick={() => void undo()} disabled={!canUndo} title="Undo (Ctrl/Cmd+Z)">
            ↶ Undo
          </button>
          <button onClick={() => void redo()} disabled={!canRedo} title="Redo (Ctrl+Y / Cmd+Shift+Z)">
            ↷ Redo
          </button>
        </div>
      </header>
      <ErrorBanner />
      <aside className="panel outline-panel">
        <div className="panel-title">Universe</div>
        <Outline />
      </aside>
      <main className="viewport-panel">
        <Viewport />
      </main>
      <aside className="panel inspector-panel">
        <Inspector />
      </aside>
      <section className="timeline-panel">
        <TimelineBar />
      </section>
      <footer className="statusbar">
        <span title={project.path}>{project.path}</span>
        <span>All changes saved</span>
        <span>
          v{__BUILD_INFO__.version} · {__BUILD_INFO__.commit}
        </span>
      </footer>
    </div>
  )
}
