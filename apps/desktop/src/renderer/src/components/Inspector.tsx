import type { NodePatch, SpatialNode } from '@universe/core'
import { useEffect, useRef } from 'react'
import { KIND_ICONS, addOptions, kindLabel } from '../kinds'
import { selectNode, useUi } from '../store'
import { NumberInput, TagsField, TextField } from './fields'
import { NotesEditor } from './NotesEditor'
import { TimelineInspector } from './TimelinePanels'
import { WorldPanel } from './WorldPanel'

export function Inspector() {
  const node = useUi(selectNode)
  const timelineSelection = useUi((s) => s.timelineSelection)
  const regionId = useUi((s) => s.selectedRegionId)
  const top = useRef<HTMLDivElement>(null)
  // Something new was picked: show its panel from the top.
  const picked = `${timelineSelection?.kind}:${timelineSelection?.ids.join()}:${regionId}`
  useEffect(() => {
    top.current?.closest('.inspector-panel')?.scrollTo({ top: 0 })
  }, [picked])
  if (!node) return <p className="muted pad">Select something in the universe tree.</p>
  // Re-mount the form when the node changes (including via undo) so fields show stored values.
  return (
    <div className="inspector" ref={top}>
      {timelineSelection && <TimelineInspector selection={timelineSelection} />}
      <NodeForm key={`${node.id}:${node.updatedAt}`} node={node} />
    </div>
  )
}

function NodeForm({ node }: { node: SpatialNode }) {
  const nodes = useUi((s) => s.nodes)
  const execute = useUi((s) => s.execute)
  const update = (patch: NodePatch) => void execute({ type: 'node.update', payload: { id: node.id, patch } })
  const options = addOptions(node, nodes)

  return (
    <>
      {node.kind === 'world' && <WorldPanel world={node} />}

      <section className="inspector-section">
        <div className="inspector-kind">
          <span>{KIND_ICONS[node.kind]}</span> {kindLabel(node, nodes)}
        </div>
        <TextField label="Name" value={node.name} required onCommit={(name) => update({ name })} />
        <TagsField label="Tags" tags={node.tags} onCommit={(tags) => update({ tags })} />
        {/* A world's seed lives with its generation options. */}
        {node.kind !== 'world' && (
        <label className="field">
          <span>Seed</span>
          <div className="field-row">
            <NumberInput value={node.seed} min={0} max={0xffffffff} integer onCommit={(seed) => update({ seed })} />
            <button title="New random seed" aria-label="New random seed" onClick={() => update({ seed: Math.floor(Math.random() * 0x100000000) })}>
              🎲
            </button>
          </div>
        </label>
        )}
        <div className="field grow">
          <span>Notes</span>
          <NotesEditor label="Notes" value={node.notes} onCommit={(notes) => update({ notes })} />
        </div>
      </section>

      {options.length > 0 && (
        <div className="field">
          <span>Add inside {node.name}</span>
          <div className="add-buttons">
            {options.map((o) => (
              <button key={o.kind} onClick={() => void execute({ type: 'node.create', payload: { parentId: node.id, kind: o.kind, name: `New ${o.label}` } })}>
                + {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {node.parentId !== null && (
        <button className="danger" onClick={() => void execute({ type: 'node.delete', payload: { id: node.id } })}>
          Delete {node.name}
        </button>
      )}
    </>
  )
}
