import { erodesAt, findBlueprint, formatTime, stateAt, STAGES, type Step, type Structure, type StructurePatch } from '@universe/core'
import { usePlayhead } from '../timeline/timelineStore'
import { useUi } from '../store'
import { STAGE_COLORS, viewingDistance } from '../world/structureLook'
import { useConditionCurves } from '../world/useStructures'
import { useEditor } from '../world/editorStore'
import { useCalendar } from '../world/useSky'
import { goToEvent } from '../world/goToEvent'
import { CommitSlider, TagsField, TextField, TimeField } from './fields'
import { BlueprintOptions } from './BlueprintOptions'
import { NotesEditor } from './NotesEditor'
import { ConditionChart, MaterialConditions } from './ConditionChart'

const STEP_LABELS: Record<Step['kind'], string> = {
  build: 'built',
  damage: 'damaged',
  destroy: 'destroyed',
  repair: 'repaired',
  maintenance: 'maintenance',
  modify: 'changed'
}

/** Inspector for a structure: what it is, where, and its condition at the playhead and why. */
export function StructurePanel({ structure }: { structure: Structure }) {
  const { execute, selectStructure } = useUi.getState()
  const events = useUi((s) => s.timeline.events)
  const maintenances = useUi((s) => s.timeline.maintenances)
  const { curves } = useConditionCurves(structure.ownerId)
  const playhead = usePlayhead(structure.ownerId)
  const cal = useCalendar(structure.ownerId)
  const curve = curves.get(structure.id)
  const state = curve && stateAt(curve, playhead)
  const update = (patch: StructurePatch) => void execute({ type: 'structure.update', payload: { id: structure.id, patch } })
  const history = maintenances.filter((m) => m.structureId === structure.id).sort((a, b) => a.at - b.at)
  const eroded = curve && erodesAt(curve, playhead)
  const caused = (curve?.steps ?? []).filter((s) => s.eventId)
  const blueprint = useUi((s) => findBlueprint(s.timeline.blueprints, structure.blueprintId))
  const eventTitle = (id: string | undefined) => events.find((e) => e.id === id)?.title ?? 'an event'

  return (
    <section className="inspector-section region-form" aria-label="Structure">
      <div className="inspector-kind">
        <span className="swatch" style={{ background: state ? STAGE_COLORS[state.stage] : undefined }} /> Structure
        <button className="link close" aria-label="Close structure" onClick={() => selectStructure(null)}>
          ✕
        </button>
      </div>
      <TextField label="Structure name" value={structure.name} required onCommit={(name) => update({ name })} />
      <label className="field">
        <span>Blueprint</span>
        <select value={structure.blueprintId} onChange={(e) => update({ blueprintId: e.target.value })}>
          <BlueprintOptions />
        </select>
      </label>
      <label className="field">
        <span>Built</span>
        <TimeField label="Built" value={structure.builtAt} precision="year" onCommit={(v) => v && update({ builtAt: v.t })} />
      </label>

      {state && (
        <div className="field" aria-label="Condition">
          <span className="field-label-row">
            Condition at {formatTime(playhead, 'year', cal)}
            <b data-testid="condition">{state.exists ? `${Math.round(state.condition)} · ${STAGES.find((s) => s.stage === state.stage)!.label}` : playhead < structure.builtAt ? 'Not built yet' : 'Gone'}</b>
          </span>
          <div className="condition-bar">
            <div style={{ width: `${state.condition}%`, background: STAGE_COLORS[state.stage] }} />
          </div>
          {state.exists && <MaterialConditions materials={state.materials} />}
          {curve && <ConditionChart curve={curve} builtAt={structure.builtAt} playhead={playhead} ownerId={structure.ownerId} cal={cal} />}
          {eroded !== undefined && <span className="muted small">Left weathered, it erodes away around {formatTime(eroded, 'year', cal)}.</span>}
        </div>
      )}

      <label className="checkbox">
        <input
          type="checkbox"
          checked={state?.maintained ?? structure.maintained}
          onChange={(e) => void execute({ type: 'maintenance.set', payload: { structureId: structure.id, at: playhead, maintained: e.target.checked } })}
        />
        Maintained from {formatTime(playhead, 'year', cal)} on
      </label>
      <div className="small">
        <div className="muted">
          {structure.maintained ? 'Maintained' : 'Weathering'} when built
          {history.length ? ', then:' : ''}
        </div>
        <ul className="plain-list">
          {history.map((m) => (
            <li key={m.id}>
              {formatTime(m.at, 'year', cal)}: {m.maintained ? 'maintained again' : 'left to weather'}
              {m.causeEventId && <> ({eventTitle(m.causeEventId)})</>}{' '}
              <button className="link" aria-label="Remove maintenance change" onClick={() => void execute({ type: 'maintenance.delete', payload: { id: m.id } })}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      </div>

      {caused.length > 0 && (
        <div className="field">
          <span>What happened to it</span>
          <ul className="plain-list small">
            {caused.map((s, i) => {
              const event = events.find((e) => e.id === s.eventId)
              return (
                <li key={i}>
                  <button className="link" onClick={() => event && goToEvent(event)}>
                    {formatTime(s.at, event?.precision ?? 'year', cal)} · {eventTitle(s.eventId)}
                  </button>{' '}
                  <span className="muted">
                    {STEP_LABELS[s.kind]}
                    {s.amount !== undefined && ` ${s.kind === 'damage' ? '−' : '+'}${Math.round(s.amount)}`}
                    {s.kind === 'maintenance' && (s.maintained ? ' resumed' : ' stopped')}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <div className="field-pair">
        <label className="checkbox">
          <input type="checkbox" checked={structure.neverDecays} onChange={(e) => update({ neverDecays: e.target.checked })} />
          Never decays
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={structure.label} onChange={(e) => update({ label: e.target.checked })} />
          Show name
        </label>
      </div>
      <div className="field">
        <span>Position</span>
        <div className="field-row">
          <span className="small">
            {structure.lat.toFixed(2)}°, {structure.lon.toFixed(2)}°
          </span>
          <button onClick={() => useEditor.getState().startTool({ tool: 'move', moveStructureId: structure.id })}>✥ Move</button>
          {blueprint && <button onClick={() => useEditor.getState().enterGround(structure, viewingDistance(blueprint, structure.scale))}>🔍 View up close</button>}
        </div>
      </div>
      <CommitSlider label="Rotation" unit="°" min={0} max={359} step={1} value={((structure.rotation % 360) + 360) % 360} onCommit={(rotation) => update({ rotation })} />
      <CommitSlider label="Size" unit="×" min={0.25} max={4} step={0.25} value={structure.scale} onCommit={(scale) => update({ scale })} />
      <TagsField label="Structure tags" tags={structure.tags} onCommit={(tags) => update({ tags })} />
      <div className="field">
        <span>Structure notes</span>
        <NotesEditor label="Structure notes" value={structure.notes} onCommit={(notes) => update({ notes })} />
      </div>
      <button className="danger" onClick={() => void execute({ type: 'structure.delete', payload: { id: structure.id } })}>
        Delete structure
      </button>
    </section>
  )
}
