import { ancestry } from '@universe/core'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { KIND_ICONS } from '../kinds'
import { isEditingText } from '../input'
import { deleteCommand, redo, selectNode, undo, useUi } from '../store'
import { ErrorBanner } from './ErrorBanner'
import { Inspector } from './Inspector'
import { Outline } from './Outline'
import { Viewport } from './Viewport'
import { ZoomStage } from './ZoomOverlay'
import { AiNotes, AiSuggestions, ConnectAiButton, UndoAiButton } from './AiPanels'
import { ThemedWorkspace } from './ThemedWorkspace'
import { ContextMenuHost } from './ContextMenu'
import { zoomOut, zoomTo } from './zoom'
import { Timeline } from '../timeline/Timeline'
import { useTimelineView } from '../timeline/timelineStore'
import { WorldEditor } from '../world/WorldEditor'

export function Workspace() {
  const selected = useUi(selectNode)
  const canUndo = useUi((s) => s.canUndo)
  const canRedo = useUi((s) => s.canRedo)
  const project = useUi((s) => s.project)!
  const shell = useRef<HTMLDivElement>(null)

  // The timeline's height goes straight onto the element, so resizing it doesn't re-render the app.
  useLayoutEffect(() => {
    const el = shell.current!
    const show = (height: number) => el.style.setProperty('--timeline-h', `${height}px`)
    show(useTimelineView.getState().height)
    return useTimelineView.subscribe((s, prev) => s.height !== prev.height && show(s.height))
  }, [])

  useEffect(() => {
    // Tools with their own keys (region drawing) handle them in the capture phase and preventDefault.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditingText()) return
      const { selectedId, selectedRegionId, selectedStructureId, selectedCharacterId, timelineSelection: tl, project: p, execute } = useUi.getState()
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Most specific first: timeline records, then a region, structure or character, then the node it's all on.
        const command =
          (tl ? deleteCommand(tl.kind, tl.ids) : undefined) ??
          (selectedRegionId
            ? deleteCommand('region', [selectedRegionId])
            : selectedStructureId
              ? deleteCommand('structure', [selectedStructureId])
              : selectedCharacterId
                ? deleteCommand('character', [selectedCharacterId])
                : selectedId && selectedId !== p?.rootId
                  ? deleteCommand('node', [selectedId])
                  : undefined)
        if (command) {
          e.preventDefault()
          void execute(command)
        }
      }
      if (e.key === 'Escape' && (tl || selectedRegionId)) {
        useUi.setState({ timelineSelection: null, selectedRegionId: null })
      } else if (e.key === 'Escape' && selectedId) {
        // Escape zooms out one level, like scrolling out in the viewport.
        zoomOut()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <ThemedWorkspace ref={shell}>
      <header className="topbar">
        <Breadcrumb />
        <div className="topbar-actions">
          <UndoAiButton />
          <button onClick={() => void undo()} disabled={!canUndo} title="Undo (Ctrl/Cmd+Z)">
            ↶ Undo
          </button>
          <button onClick={() => void redo()} disabled={!canRedo} title="Redo (Ctrl+Y / Cmd+Shift+Z)">
            ↷ Redo
          </button>
          <ConnectAiButton />
        </div>
      </header>
      <ErrorBanner />
      <ContextMenuHost />
      <aside className="panel outline-panel">
        <div className="panel-title">Universe</div>
        <Outline />
      </aside>
      <main className="viewport-panel">
        <ZoomStage>{selected?.kind === 'world' ? <WorldEditor key={selected.id} world={selected} /> : <Viewport />}</ZoomStage>
        <AiSuggestions />
        <AiNotes />
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
    </ThemedWorkspace>
  )
}

/** Where the selection is: it and its ancestors, each a button that zooms there. */
function Breadcrumb() {
  const nodes = useUi((s) => s.nodes)
  const selectedId = useUi((s) => s.selectedId)
  const path = useMemo(() => (selectedId ? ancestry(nodes, selectedId) : []), [nodes, selectedId])
  return (
    <nav className="breadcrumb" aria-label="Location">
      {path.map((n, i) => (
        <span key={n.id} className="crumb">
          {i > 0 && <span className="crumb-sep">›</span>}
          <button className="link" onClick={() => zoomTo(n.id)} aria-current={i === path.length - 1}>
            <span className="crumb-icon">{KIND_ICONS[n.kind]}</span>
            {n.name}
          </button>
        </span>
      ))}
    </nav>
  )
}

/** Drag handle on the timeline panel's top edge to make it taller or shorter; the height is saved when it's let go. */
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
          useTimelineView.getState().saveHeight()
        }
        el.addEventListener('pointermove', onMove)
        el.addEventListener('pointerup', onUp)
      }}
    />
  )
}
