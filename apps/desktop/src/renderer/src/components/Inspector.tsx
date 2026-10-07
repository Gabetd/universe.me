import type { NodePatch, SpatialNode } from '@universe/core'
import { useState } from 'react'
import { KIND_ICONS, addOptions, kindLabel } from '../kinds'
import { selectNode, useUi } from '../store'

export function Inspector() {
  const node = useUi(selectNode)
  if (!node) return <p className="muted pad">Select something in the universe tree.</p>
  // Re-mount the form when the node changes (including via undo) so fields show stored values.
  return <NodeForm key={`${node.id}:${node.updatedAt}`} node={node} />
}

function NodeForm({ node }: { node: SpatialNode }) {
  const nodes = useUi((s) => s.nodes)
  const execute = useUi((s) => s.execute)
  const isRoot = node.parentId === null
  const [name, setName] = useState(node.name)
  const [tags, setTags] = useState(node.tags.join(', '))
  const [seed, setSeed] = useState(String(node.seed))
  const [notes, setNotes] = useState(node.notes)

  const update = (patch: NodePatch) => void execute({ type: 'node.update', payload: { id: node.id, patch } })

  const commitName = () => {
    const v = name.trim()
    if (!v) setName(node.name)
    else if (v !== node.name) update({ name: v })
  }
  const commitTags = () => {
    const v = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    if (v.join('\u0000') !== node.tags.join('\u0000')) update({ tags: v })
  }
  const commitSeed = () => {
    const v = Number(seed)
    if (Number.isInteger(v) && v >= 0 && v <= 0xffffffff && v !== node.seed) update({ seed: v })
    else setSeed(String(node.seed))
  }
  const commitNotes = () => {
    if (notes !== node.notes) update({ notes })
  }
  const onEnter = (commit: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      commit()
      ;(e.target as HTMLElement).blur()
    }
  }

  const options = addOptions(node, nodes)

  return (
    <div className="inspector">
      <div className="inspector-kind">
        <span>{KIND_ICONS[node.kind]}</span> {kindLabel(node, nodes)}
      </div>

      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={onEnter(commitName)} />
      </label>

      <label className="field">
        <span>Tags</span>
        <input
          value={tags}
          placeholder="comma, separated"
          onChange={(e) => setTags(e.target.value)}
          onBlur={commitTags}
          onKeyDown={onEnter(commitTags)}
        />
      </label>

      <label className="field">
        <span>Seed</span>
        <div className="field-row">
          <input value={seed} inputMode="numeric" onChange={(e) => setSeed(e.target.value)} onBlur={commitSeed} onKeyDown={onEnter(commitSeed)} />
          <button title="New random seed" onClick={() => update({ seed: Math.floor(Math.random() * 0x100000000) })}>
            🎲
          </button>
        </div>
      </label>

      <label className="field grow">
        <span>Notes</span>
        <textarea value={notes} placeholder="Lore, ideas, anything…" onChange={(e) => setNotes(e.target.value)} onBlur={commitNotes} />
      </label>

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

      {!isRoot && (
        <button className="danger" onClick={() => void execute({ type: 'node.delete', payload: { id: node.id } })}>
          Delete {node.name}
        </button>
      )}
    </div>
  )
}
