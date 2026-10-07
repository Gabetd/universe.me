import {
  EFFECT_TYPES,
  MATERIALS,
  MATERIAL_INFO,
  effectHits,
  eventPlace,
  type EffectPatch,
  type EffectTarget,
  type EffectType,
  type EventEffect,
  type TimelineEvent
} from '@universe/core'
import { useMemo } from 'react'
import { useUi } from '../store'
import { useStructureWorld } from '../world/useStructures'
import { BlueprintOptions } from './BlueprintOptions'
import { CommitSlider, NumberInput, TagsField, TextField } from './fields'

export const EFFECT_LABELS: Record<EffectType, { label: string; icon: string }> = {
  build: { label: 'Build / rebuild', icon: '🔨' },
  damage: { label: 'Damage', icon: '💥' },
  destroy: { label: 'Destroy', icon: '💀' },
  repair: { label: 'Repair', icon: '🔧' },
  set_maintenance: { label: 'Abandon / maintain', icon: '🏚' },
  modify: { label: 'Rename / change', icon: '✎' }
}

const TARGET_LABELS: Record<EffectTarget['kind'], string> = { structures: 'Chosen structures', region: 'Everything in a region', radius: 'Everything nearby' }

/** What an event does to structures (PLAN.md §4.7), with a preview of what each effect reaches. */
export function EventEffects({ event }: { event: TimelineEvent }) {
  const { execute } = useUi.getState()
  const all = useUi((s) => s.timeline.effects)
  const effects = useMemo(() => all.filter((e) => e.eventId === event.id), [all, event.id])
  const hasPlace = !!eventPlace(event, useUi.getState().regions)
  return (
    <div className="field" aria-label="Effects on structures">
      <span>Effects on structures</span>
      {effects.map((effect) => (
        <EffectEditor key={`${effect.id}:${effect.updatedAt}`} effect={effect} event={event} />
      ))}
      <div className="add-buttons">
        <button
          onClick={() =>
            void execute({
              type: 'effect.create',
              payload: { eventId: event.id, type: 'damage', target: hasPlace ? { kind: 'radius', km: 100, falloff: true } : { kind: 'structures', ids: [] } }
            })
          }
        >
          + Effect
        </button>
      </div>
    </div>
  )
}

function EffectEditor({ effect, event }: { effect: EventEffect; event: TimelineEvent }) {
  const { execute } = useUi.getState()
  const world = useStructureWorld(effect.ownerId)
  const regions = world.regions
  const structures = world.data.structures
  const update = (patch: EffectPatch) => void execute({ type: 'effect.update', payload: { id: effect.id, patch } })
  const hits = useMemo(() => effectHits(effect, world), [effect, world])
  const name = (id: string) => structures.find((s) => s.id === id)?.name ?? '?'
  const t = effect.target

  const setType = (type: EffectType) =>
    // A modify effect has to change something; start it off with a new name.
    update(type === 'modify' && !effect.rename && !effect.blueprintId ? { type, rename: `New ${event.title}`.slice(0, 200) } : { type })

  const setTargetKind = (kind: EffectTarget['kind']) =>
    update({
      target:
        kind === 'structures' ? { kind, ids: [] } : kind === 'region' ? { kind, regionId: regions[0]?.id ?? '' } : { kind, km: 100, falloff: true }
    })

  const amountShown = effect.type === 'damage' || effect.type === 'repair'
  const sign = effect.type === 'damage' ? '−' : '+'

  return (
    <div className="effect-editor">
      <div className="field-row">
        <select aria-label="Effect" value={effect.type} onChange={(e) => setType(e.target.value as EffectType)}>
          {EFFECT_TYPES.map((type) => (
            <option key={type} value={type}>
              {EFFECT_LABELS[type].icon} {EFFECT_LABELS[type].label}
            </option>
          ))}
        </select>
        <button className="link" aria-label="Remove effect" onClick={() => void execute({ type: 'effect.delete', payload: { id: effect.id } })}>
          ✕
        </button>
      </div>

      {amountShown && <CommitSlider label="Amount" min={0} max={100} step={5} value={effect.amount} onCommit={(amount) => update({ amount })} />}
      {effect.type === 'set_maintenance' && (
        <select aria-label="Maintenance" value={String(effect.maintained)} onChange={(e) => update({ maintained: e.target.value === 'true' })}>
          <option value="false">Abandon: stop maintaining</option>
          <option value="true">Maintain again</option>
        </select>
      )}
      {effect.type === 'modify' && (
        <>
          <TextField label="New name" value={effect.rename ?? ''} placeholder="(keep the name)" onCommit={(v) => update({ rename: v || null })} />
          <select aria-label="New blueprint" value={effect.blueprintId ?? ''} onChange={(e) => update({ blueprintId: e.target.value || null })}>
            <option value="">Keep the blueprint</option>
            <BlueprintOptions prefix="Becomes: " />
          </select>
        </>
      )}

      <label className="field">
        <span>Reaches</span>
        <select aria-label="Reaches" value={t.kind} onChange={(e) => setTargetKind(e.target.value as EffectTarget['kind'])}>
          {(Object.keys(TARGET_LABELS) as EffectTarget['kind'][]).map((k) => (
            <option key={k} value={k}>
              {TARGET_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      {t.kind === 'structures' && (
        <fieldset className="check-list" aria-label="Structures">
          {structures.length === 0 && <span className="muted small">No structures on this world yet.</span>}
          {structures.map((s) => (
            <label key={s.id} className="checkbox">
              <input
                type="checkbox"
                aria-label={s.name}
                checked={t.ids.includes(s.id)}
                onChange={(e) => update({ target: { kind: 'structures', ids: e.target.checked ? [...t.ids, s.id] : t.ids.filter((id) => id !== s.id) } })}
              />
              {s.name}
            </label>
          ))}
        </fieldset>
      )}
      {t.kind === 'region' && (
        <select aria-label="Region" value={t.regionId} onChange={(e) => update({ target: { kind: 'region', regionId: e.target.value } })}>
          {regions.length === 0 && <option value="">No regions yet</option>}
          {regions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      )}
      {t.kind === 'radius' && (
        <div className="field-pair">
          <label className="field">
            <span>Radius (km)</span>
            <NumberInput value={t.km} min={0.1} max={50000} onCommit={(km) => update({ target: { ...t, km } })} />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={t.falloff} onChange={(e) => update({ target: { ...t, falloff: e.target.checked } })} />
            Weaker farther out
          </label>
        </div>
      )}
      {t.kind !== 'structures' && (
        <details className="small">
          <summary>Only some structures{effect.filter.tags.length + effect.filter.materials.length ? ' (filtered)' : ''}</summary>
          <TagsField label="With tags" tags={effect.filter.tags} onCommit={(tags) => update({ filter: { ...effect.filter, tags } })} />
          <div className="chip-toggles" role="group" aria-label="Made of">
            {MATERIALS.map((m) => {
              const on = effect.filter.materials.includes(m)
              return (
                <button
                  key={m}
                  aria-pressed={on}
                  onClick={() => update({ filter: { ...effect.filter, materials: on ? effect.filter.materials.filter((x) => x !== m) : [...effect.filter.materials, m] } })}
                >
                  {MATERIAL_INFO[m].label}
                </button>
              )
            })}
          </div>
        </details>
      )}

      <p className="muted small effect-preview">
        {hits.length === 0
          ? t.kind === 'radius' && !eventPlace(event, regions)
            ? 'Give the event a place for this to reach anything.'
            : 'Reaches no structures.'
          : `Reaches ${hits.length} structure${hits.length === 1 ? '' : 's'}: ${hits
              .map((h) => `${name(h.structureId)}${amountShown ? ` ${sign}${Math.round(effect.amount * h.strength)}` : ''}`)
              .join(', ')}`}
      </p>
    </div>
  )
}
