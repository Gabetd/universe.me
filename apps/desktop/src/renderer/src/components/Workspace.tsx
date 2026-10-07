import { ancestry, type Command } from '@universe/core'
import { useEffect } from 'react'
import { KIND_ICONS } from '../kinds'
import { isEditingText } from '../input'
import { redo, selectNode, undo, useUi } from '../store'
import { ErrorBanner } from './ErrorBanner'
import { Inspector } from './Inspector'
import { Outline } from './Outline'
import { Viewport } from './Viewport'
import { Timeline } from '../timeline/Timeline'
import { useTimelineView } from '../timeline/timelineStore'
import { WorldEditor } from '../world/WorldEditor'

export function Workspace() {
  const nodes = useUi((s) => s.nodes)
  const selected = useUi(selectNode)
  const canUndo = useUi((s) => s.canUndo)
  const canRedo = useUi((s) => s.canRedo)
  const project = useUi((s) => s.project)!
  const select = useUi((s) => s.select)
  const path = selected ? ancestry(nodes, selected.id) : []
  const timelineHeight = useTimelineView((s) => s.height)

  useEffect(() => {
    // Tools with their own keys (region drawing) handle them in the capture phase and preventDefault.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditingText()) return
      const { selectedId, selectedRegionId, timelineSelection: tl, project: p, execute, nodes: all } = useUi.getState()
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Most specific first: timeline records, then a region, then the node it's all on.
        const deletes: Command[] = tl ? tl.ids.map((id) => ({ type: `${tl.kind}.delete`, payload: { id } }) as Command) : []
        const command = deletes.length
          ? deletes.length === 1
            ? deletes[0]
            : ({ type: 'batch', payload: { commands: deletes } } as const)
          : selectedRegionId
          ? ({ type: 'region.delete', payload: { id: selectedRegionId } } as const)
          : selectedId && selectedId !== p?.rootId
            ? ({ type: 'node.delete', payload: { id: selectedId } } as const)
            : undefined
        if (command) {
          e.preventDefault()
          void execute(command)
        }
      }
      if (e.key === 'Escape' && (tl || selectedRegionId)) {
        useUi.setState({ timelineSelection: null, selectedRegionId: null })
      } else if (e.key === 'Escape' && selectedId) {
        // Escape zooms out one level, like the scroll wheel in the viewport.
        const parent = all.find((n) => n.id === selectedId)?.parentId
        if (parent) useUi.getState().select(parent)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="workspace" style={{ ['--timeline-h' as string]: `${timelineHeight}px` }}>
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
        {selected?.kind === 'world' ? <WorldEditor key={selected.id} world={selected} /> : <Viewport />}
      </main>
      <aside className="panel inspector-panel">
        <Inspector />
      </aside>
      <section className="timeline-panel">
        <TimelineResizer />
        <Timeline />
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

/** Drag handle on the timeline panel's top edge to make it taller or shorter. */
function TimelineResizer() {
  return (
    <div
      className="timeline-resizer"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize timeline"
      onPointerDown={(e) => {
        const startY = e.clientY
        const startH = useTimelineView.getState().height
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        const onMove = (m: PointerEvent) => {
          const max = window.innerHeight - 220
          useTimelineView.getState().setHeight(Math.round(Math.min(max, Math.max(120, startH + startY - m.clientY))))
        }
        const onUp = () => {
          el.removeEventListener('pointermove', onMove)
          el.removeEventListener('pointerup', onUp)
        }
        el.addEventListener('pointermove', onMove)
        el.addEventListener('pointerup', onUp)
      }}
    />
  )
}
