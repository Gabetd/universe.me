import { BUILTIN_BLUEPRINTS, type Blueprint } from '@universe/core'
import { useState } from 'react'
import { useUi } from '../store'
import { useEditor } from '../world/editorStore'
import { BlueprintBuilder, newPart, type BlueprintDraft } from './BlueprintBuilder'

const draftOf = ({ name, parts, model, maintainedByDefault, tags }: Blueprint): BlueprintDraft => ({ name, parts, model, maintainedByDefault, tags })

/** The project's blueprints next to the built-in ones: copy, edit, build new ones, or import a glTF model. */
export function BlueprintLibrary() {
  const library = useUi((s) => s.timeline.blueprints)
  const { execute, run, apply } = useUi.getState()
  const rootId = useUi((s) => s.project?.rootId)
  const [editing, setEditing] = useState<BlueprintDraft | null>(null)

  const importModel = async () => {
    if (!rootId) return
    // The main process reads the file into the project; the builder then sets its height and material and adds the blueprint.
    const imported = await run(window.universe.importModel())
    if (!imported) return
    apply(imported.state)
    const name = imported.name.replace(/\.(glb|gltf)$/i, '')
    setEditing({ name, parts: [], model: { assetId: imported.assetId, material: 'stone', heightM: 10 }, maintainedByDefault: true, tags: [] })
  }

  const row = (b: Blueprint, own: boolean) => (
    <li key={b.id} className="blueprint-row">
      <button className="link" title="Place it" onClick={() => useEditor.getState().startTool({ tool: 'place', placeBlueprintId: b.id })}>
        {b.model ? '📦' : own ? '🏗' : '🏛'} {b.name}
      </button>
      <span className="blueprint-actions">
        {own && (
          <button className="link" onClick={() => setEditing({ ...draftOf(b), id: b.id })}>
            Edit
          </button>
        )}
        <button className="link" onClick={() => setEditing({ ...draftOf(b), name: `${b.name} (copy)` })}>
          Copy
        </button>
        {own && (
          <button className="link" aria-label={`Delete ${b.name}`} onClick={() => void execute({ type: 'blueprint.delete', payload: { id: b.id } })}>
            ✕
          </button>
        )}
      </span>
    </li>
  )

  return (
    <section className="inspector-section" aria-label="Blueprint library">
      <h3>Blueprints</h3>
      <ul className="region-list">
        {library.map((b) => row(b, true))}
        {BUILTIN_BLUEPRINTS.map((b) => row(b, false))}
      </ul>
      <div className="add-buttons">
        <button onClick={() => setEditing({ name: 'New blueprint', parts: [newPart()], model: null, maintainedByDefault: true, tags: [] })}>
          + New blueprint
        </button>
        <button onClick={() => void importModel()}>Import 3D model…</button>
      </div>
      {editing && <BlueprintBuilder initial={editing} onClose={() => setEditing(null)} />}
    </section>
  )
}
