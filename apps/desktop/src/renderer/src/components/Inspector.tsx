import type { SpatialNode } from '@universe/core'
import { useRef } from 'react'
import { KIND_ICONS, addOptions, kindLabel } from '../kinds'
import { selectNode, updater, useUi } from '../store'
import { DeleteButton, NotesField, NumberInput, TagsField, TextField, randomSeed } from './fields'
import { TimelineInspector } from './TimelinePanels'
import { WorldPanel } from './WorldPanel'
import { OrbitPanel, StarPanel } from './SkyPanels'
import { PlanetsToClaim } from './ClaimPlanets'
import { useSteadyScroll } from '../useSteadyScroll'

export function Inspector() {
  const node = useUi(selectNode)
  const timelineSelection = useUi((s) => s.timelineSelection)
  // What the inspector is showing: picking something else shows its panel from the top; while it's the same, the panel stays still.
  const menu = useUi((s) => [s.selectedId, s.selectedRegionId, s.selectedStructureId, s.selectedCharacterId, s.timelineSelection?.kind, s.timelineSelection?.ids.join()].join(':'))
  const content = useRef<HTMLDivElement>(null)
  useSteadyScroll(content, menu)
  return (
    <div className="inspector" ref={content}>
      {!node ? (
        <p className="muted pad">Select something in the universe tree.</p>
      ) : (
        <>
          {timelineSelection && <TimelineInspector selection={timelineSelection} />}
          {/* A form per node; its fields show new stored values (undo, an edit elsewhere) themselves, so a save doesn't rebuild the panel. */}
          <NodeForm key={node.id} node={node} />
        </>
      )}
    </div>
  )
}

function NodeForm({ node }: { node: SpatialNode }) {
  const nodes = useUi((s) => s.nodes)
  const execute = useUi((s) => s.execute)
  const update = updater('node', node.id)
  const options = addOptions(node, nodes)

  return (
    <>
      {node.kind === 'world' && <WorldPanel world={node} />}
      {node.kind === 'star_system' && <StarPanel system={node} />}
      {node.kind === 'body' && <OrbitPanel body={node} />}

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
              <button title="New random seed" aria-label="New random seed" onClick={() => update({ seed: randomSeed() })}>
                🎲
              </button>
            </div>
          </label>
        )}
        <NotesField label="Notes" value={node.notes} grow onCommit={(notes) => update({ notes })} />
      </section>

      {options.length > 0 && (
        <div className="field">
          <span>Add inside {node.name}</span>
          <div className="add-buttons">
            {options.map((o) => (
              <button
                key={o.kind}
                onClick={() =>
                  void execute({
                    type: 'node.create',
                    payload: {
                      parentId: node.id,
                      kind: o.kind,
                      name: `New ${o.label}`
                    }
                  })
                }
              >
                + {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {node.kind === 'star_system' && <PlanetsToClaim node={node} />}

      {node.parentId !== null && (
        <DeleteButton kind="node" ids={[node.id]}>
          Delete {node.name}
        </DeleteButton>
      )}
    </>
  )
}
