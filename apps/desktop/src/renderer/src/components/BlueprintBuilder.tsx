import { MATERIALS, MATERIAL_INFO, SHAPES, STAGES, stageOf, type Blueprint, type BlueprintPart, type Material, type Shape } from '@universe/core'
import { OrbitControls } from '@react-three/drei'
import { Canvas, useThree } from '@react-three/fiber'
import { useEffect, useState } from 'react'
import { SPACE_BG } from '../theme'
import { useUi } from '../store'
import { blueprintExtent } from '../world/structureLook'
import { BlueprintParts } from '../world/StructureMesh'

/** A blueprint being edited: saved as a new one when it has no id. */
export type BlueprintDraft = Pick<Blueprint, 'name' | 'parts' | 'model' | 'maintainedByDefault' | 'tags'> & { id?: string }

const SHAPE_LABELS: Record<Shape, string> = { box: 'Box', cylinder: 'Cylinder', cone: 'Cone', pyramid: 'Pyramid', sphere: 'Sphere' }

const newPart = (): BlueprintPart => ({ shape: 'box', material: 'stone', color: MATERIAL_INFO.stone.color, size: [10, 10, 10], at: [0, 0, 0], rotation: 0 })

/**
 * Builds a blueprint from primitives (or sets up an imported model), with a
 * live preview that can be aged to see how it will weather. Saves once.
 */
export function BlueprintBuilder({ initial, onClose }: { initial: BlueprintDraft; onClose(): void }) {
  const [draft, setDraft] = useState(initial)
  const [preview, setPreview] = useState(100)
  const rootId = useUi((s) => s.project?.rootId)
  const execute = useUi((s) => s.execute)
  const extent = blueprintExtent(draft as Blueprint)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const setPart = (i: number, patch: Partial<BlueprintPart>) => setDraft({ ...draft, parts: draft.parts.map((p, j) => (j === i ? { ...p, ...patch } : p)) })
  const setVec = (i: number, key: 'size' | 'at', axis: number, v: number) => {
    const next = [...draft.parts[i]![key]] as [number, number, number]
    next[axis] = v
    setPart(i, { [key]: next })
  }

  const save = async () => {
    const { id, ...fields } = draft
    const name = fields.name.trim() || 'Untitled blueprint'
    const ok = id
      ? await execute({ type: 'blueprint.update', payload: { id, patch: { ...fields, name } } })
      : await execute({ type: 'blueprint.create', payload: { ...fields, name, ownerId: rootId! } })
    if (ok) onClose()
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal blueprint-builder" role="dialog" aria-label="Blueprint builder">
        <div className="blueprint-preview">
          <Canvas camera={{ position: [extent * 1.1, extent * 0.8, extent * 1.4], fov: 40, near: 0.1, far: extent * 50 }} data-testid="blueprint-preview">
            <color attach="background" args={[SPACE_BG]} />
            <ambientLight intensity={0.6} />
            <directionalLight position={[extent, extent * 2, extent * 0.8]} intensity={2} />
            <gridHelper args={[extent * 3, 12, '#2c3a78', '#1b2238']} />
            <BlueprintParts blueprint={draft as Blueprint} condition={preview} />
            <OrbitControls makeDefault />
            <FitCamera extent={extent} />
          </Canvas>
          <label className="field blueprint-age">
            <span className="field-label-row">
              Preview condition
              <span className="muted">
                {preview} · {stageOf(preview) === 'destroyed' ? 'Destroyed' : STAGES.find((s) => s.stage === stageOf(preview))!.label}
              </span>
            </span>
            <input type="range" aria-label="Preview condition" min={1} max={100} value={preview} onChange={(e) => setPreview(Number(e.target.value))} />
          </label>
        </div>

        <div className="blueprint-form">
          <label className="field">
            <span>Blueprint name</span>
            <input aria-label="Blueprint name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={draft.maintainedByDefault} onChange={(e) => setDraft({ ...draft, maintainedByDefault: e.target.checked })} />
            New structures start out maintained
          </label>
          <label className="field">
            <span>Tags</span>
            <input
              aria-label="Blueprint tags"
              placeholder="comma, separated"
              value={draft.tags.join(', ')}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
            />
          </label>

          {draft.model ? (
            <div className="field-pair">
              <label className="field">
                <span>Made of</span>
                <MaterialSelect value={draft.model.material} onChange={(material) => setDraft({ ...draft, model: { ...draft.model!, material } })} />
              </label>
              <label className="field">
                <span>Real height (m)</span>
                <Num label="Real height (m)" value={draft.model.heightM} min={0.1} onChange={(heightM) => setDraft({ ...draft, model: { ...draft.model!, heightM } })} />
              </label>
            </div>
          ) : (
            <div className="field">
              <span>Parts (metres; the base of each part sits at its position)</span>
              <div className="part-list">
                {draft.parts.map((p, i) => (
                  <div className="part-row" key={i} aria-label={`Part ${i + 1}`}>
                    <div className="field-row">
                      <select aria-label="Shape" value={p.shape} onChange={(e) => setPart(i, { shape: e.target.value as Shape })}>
                        {SHAPES.map((s) => (
                          <option key={s} value={s}>
                            {SHAPE_LABELS[s]}
                          </option>
                        ))}
                      </select>
                      <MaterialSelect value={p.material} onChange={(material) => setPart(i, { material, color: MATERIAL_INFO[material].color })} />
                      <input type="color" aria-label="Part color" value={p.color} onChange={(e) => setPart(i, { color: e.target.value })} />
                      <button className="link" title="Duplicate part" aria-label="Duplicate part" onClick={() => setDraft({ ...draft, parts: [...draft.parts.slice(0, i + 1), { ...p }, ...draft.parts.slice(i + 1)] })}>
                        ⧉
                      </button>
                      <button className="link" title="Remove part" aria-label="Remove part" onClick={() => setDraft({ ...draft, parts: draft.parts.filter((_, j) => j !== i) })}>
                        ✕
                      </button>
                    </div>
                    <div className="vec-row">
                      <span className="muted small">Size</span>
                      {['W', 'H', 'D'].map((axis, a) => (
                        <Num key={axis} label={`${axis} size`} value={p.size[a]!} min={0.1} onChange={(v) => setVec(i, 'size', a, v)} />
                      ))}
                    </div>
                    <div className="vec-row">
                      <span className="muted small">At</span>
                      {['X', 'Y', 'Z'].map((axis, a) => (
                        <Num key={axis} label={`${axis} position`} value={p.at[a]!} onChange={(v) => setVec(i, 'at', a, v)} />
                      ))}
                      <Num label="Turn (°)" value={p.rotation} onChange={(rotation) => setPart(i, { rotation })} />
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={() => setDraft({ ...draft, parts: [...draft.parts, newPart()] })}>+ Part</button>
            </div>
          )}

          <div className="modal-actions">
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={!draft.model && draft.parts.length === 0} onClick={() => void save()}>
              {draft.id ? 'Save blueprint' : 'Add to library'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Frames the blueprint whenever its size changes. */
function FitCamera({ extent }: { extent: number }) {
  const get = useThree((s) => s.get)
  useEffect(() => {
    const { camera, controls } = get()
    const orbit = controls as unknown as { target: { set(x: number, y: number, z: number): void }; update(): void } | null
    camera.position.set(extent * 1.5, extent * 1.1, extent * 1.9)
    camera.far = extent * 50
    camera.updateProjectionMatrix()
    orbit?.target.set(0, extent * 0.3, 0)
    orbit?.update()
  }, [extent, get])
  return null
}

function MaterialSelect({ value, onChange }: { value: Material; onChange(m: Material): void }) {
  return (
    <select aria-label="Material" value={value} onChange={(e) => onChange(e.target.value as Material)}>
      {MATERIALS.map((m) => (
        <option key={m} value={m}>
          {MATERIAL_INFO[m].label}
        </option>
      ))}
    </select>
  )
}

/** A number box for the draft: while typing, text that isn't a valid number is kept and ignored. */
function Num({ label, value, min, onChange }: { label: string; value: number; min?: number; onChange(v: number): void }) {
  const [text, setText] = useState<string | null>(null)
  return (
    <input
      aria-label={label}
      title={label}
      inputMode="decimal"
      value={text ?? String(value)}
      onFocus={() => setText(String(value))}
      onBlur={() => setText(null)}
      onChange={(e) => {
        setText(e.target.value)
        const v = Number(e.target.value)
        if (e.target.value.trim() && Number.isFinite(v) && (min === undefined || v >= min)) onChange(v)
      }}
    />
  )
}
