import type { SpatialNode } from '@universe/core'
import { useRef } from 'react'
import { KIND_ICONS, addChildCommand, addOptions, canDelete, kindLabel, renameCommand, shownAs } from '../kinds'
import { selectNode, updater, useUi } from '../store'
import { DeleteButton, NotesField, NumberInput, TagsField, TextField, randomSeed } from './fields'
import { TimelineInspector } from './TimelinePanels'
import { WorldPanel } from './WorldPanel'
import { OrbitPanel, StarPanel } from './SkyPanels'
import { PlanetsToClaim } from './ClaimPlanets'
import { PowersHere } from './PowerPins'
import { NodeLanguage } from './LanguagePanels'
import { useSteadyScroll } from '../useSteadyScroll'

export function Inspector() {
  const node = useUi(selectNode)
  const timelineSelection = useUi((s) => s.timelineSelection)
  // What the inspector is showing: picking something else shows its panel from the top; while it's the same, the panel stays still.
  const menu = useUi((s) => [s.selectedId, s.selectedRegionId, s.selectedStructureId, s.selectedCharacterId, s.selectedWaterwayKey, s.timelineSelection?.kind, s.timelineSelection?.ids.join()].join(':'))
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
  // A surface is shown as its planet or moon: their one name, its orbit, its moons to add, and deleting it.
  const item = shownAs(node, nodes)
  const options = addOptions(item, nodes)

  return (
    <>
      {node.kind === 'world' && <WorldPanel world={node} />}
      {node.kind === 'star_system' && <StarPanel system={node} />}
      {item.kind === 'body' && <OrbitPanel body={item} withSurface={item !== node} />}

      <section className="inspector-section">
        <div className="inspector-kind">
          <span>{KIND_ICONS[node.kind]}</span> {kindLabel(item, nodes)}
        </div>
        <TextField label="Name" value={item.name} required onCommit={(name) => void execute(renameCommand(item, nodes, name))} />
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
          <span>Add inside {item.name}</span>
          <div className="add-buttons">
            {options.map((o) => (
              <button
                key={o.kind}
                onClick={() => void execute(addChildCommand(item, o.kind, o.label))}
              >
                + {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {node.kind === 'star_system' && <PlanetsToClaim node={node} />}
      <PowersHere node={node} />
      <NodeLanguage node={node} />

      {canDelete(item) && (
        <DeleteButton kind="node" ids={[item.id]}>
          Delete {item.name}
        </DeleteButton>
      )}
    </>
  )
}
