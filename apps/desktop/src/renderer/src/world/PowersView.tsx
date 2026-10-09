import {
  POWER_TEMPLATES,
  POWER_TEMPLATE_INFO,
  aspectId,
  eraAt,
  erasInOrder,
  formatTime,
  secondsPerYear,
  type AspectValues,
  type Era,
  type PowerAge,
  type PowerAgePatch,
  type PowerPatch,
  type PowerSystem,
  type PowerTemplate
} from '@universe/core'
import { useMemo, useRef, useState } from 'react'
import { ColorField, CommitSlider, DeleteButton, NotesField, SelectField, Swatch, TextAreaField, TextField } from '../components/fields'
import { openElementMenu } from '../contextMenu'
import { useUi } from '../store'
import { usePlayhead } from '../timeline/timelineStore'
import { useSteadyScroll } from '../useSteadyScroll'
import { flagClass, useFlaggedIds } from '../flags'
import { useCalendar } from './useSky'

/**
 * A world's power systems (PLAN.md §4.6): how its magic, faith, technology
 * or politics work, age by age. The list on the left; on the right one
 * system, with what's true in every age ("Always") and, for each of the
 * world's eras, what's different then and how strong it is.
 */

const TEMPLATE_LABELS = Object.fromEntries(POWER_TEMPLATES.map((t) => [t, POWER_TEMPLATE_INFO[t].label])) as Record<PowerTemplate, string>
/** The "Always" tab: what holds in every age. */
const ALWAYS = 'always'

const byOwner = <T extends { ownerId: string }>(list: T[], worldId: string) => list.filter((r) => r.ownerId === worldId)
const execute = (command: Parameters<ReturnType<typeof useUi.getState>['execute']>[0]) => useUi.getState().execute(command)

/** Answers with one changed: an empty answer is dropped rather than kept as "". */
function withValue(values: AspectValues, id: string, value: string): AspectValues {
  const { [id]: _old, ...rest } = values
  return value ? { ...rest, [id]: value } : rest
}

export function PowersView({ worldId }: { worldId: string }) {
  const allSystems = useUi((s) => s.timeline.powers)
  const allAges = useUi((s) => s.timeline.powerAges)
  const allEras = useUi((s) => s.timeline.eras)
  const systems = useMemo(() => byOwner(allSystems, worldId), [allSystems, worldId])
  const ages = useMemo(() => byOwner(allAges, worldId), [allAges, worldId])
  const eras = useMemo(() => erasInOrder(byOwner(allEras, worldId)), [allEras, worldId])
  const playhead = usePlayhead(worldId)
  const nowEra = eraAt(eras, playhead)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = systems.find((s) => s.id === selectedId) ?? systems[0]
  const flagged = useFlaggedIds()

  const add = async (template: PowerTemplate) => {
    const state = await execute({ type: 'power.create', payload: { ownerId: worldId, template } })
    if (state?.focus?.id) setSelectedId(state.focus.id)
  }
  const menu = (e: React.MouseEvent, id: string) => {
    e.preventDefault()
    openElementMenu({ kind: 'power', id }, e.clientX, e.clientY, { open: () => setSelectedId(id) })
  }

  return (
    <div className="powers-view">
      <aside className="eco-side">
        <select aria-label="New power system" value="" onChange={(e) => e.target.value && void add(e.target.value as PowerTemplate)}>
          <option value="">+ Power system…</option>
          {POWER_TEMPLATES.map((t) => (
            <option key={t} value={t}>
              {TEMPLATE_LABELS[t]}
            </option>
          ))}
        </select>
        <ul className="region-list" aria-label="Power systems">
          {systems.map((s) => (
            <li key={s.id}>
              <button className={`link region-row${s.id === selected?.id ? ' selected' : ''}${flagClass(flagged.has(s.id))}`} onClick={() => setSelectedId(s.id)} onContextMenu={(e) => menu(e, s.id)}>
                <Swatch color={s.color} />
                {s.name} <span className="muted small">· {TEMPLATE_LABELS[s.template]}</span>
              </button>
            </li>
          ))}
        </ul>
        {nowEra && <p className="muted small">At the playhead: {nowEra.name}.</p>}
      </aside>
      {selected ? (
        <SystemEditor key={selected.id} worldId={worldId} system={selected} ages={ages} eras={eras} nowEra={nowEra} />
      ) : (
        <section className="powers-start" aria-label="Start a power system">
          <h3>How do powers work on this world?</h3>
          <p className="muted">Pick a kind to start from. Each asks a few questions (you can change them), answered for every age and again for any age where things are different.</p>
          <div className="powers-templates">
            {POWER_TEMPLATES.map((t) => (
              <button key={t} onClick={() => void add(t)}>
                <Swatch color={POWER_TEMPLATE_INFO[t].color} /> <b>{TEMPLATE_LABELS[t]}</b>
                <span className="muted small">{POWER_TEMPLATE_INFO[t].about}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function SystemEditor({ worldId, system, ages, eras, nowEra }: { worldId: string; system: PowerSystem; ages: PowerAge[]; eras: Era[]; nowEra: Era | undefined }) {
  const update = (patch: PowerPatch) => void execute({ type: 'power.update', payload: { id: system.id, patch } })
  const own = ages.filter((a) => a.systemId === system.id)
  // Opens on the age the playhead is in; after that, only a click changes it.
  const [tab, setTab] = useState(() => nowEra?.id ?? ALWAYS)
  const era = eras.find((e) => e.id === tab)
  // Stays put while you write in it; another age or system starts from the top.
  const content = useRef<HTMLElement>(null)
  useSteadyScroll(content, `${system.id}:${era ? era.id : ALWAYS}`)

  return (
    <div className="powers-scroll">
      <section className="powers-editor" aria-label="Power system" ref={content}>
        <div className="powers-head">
          <TextField label="Power system name" value={system.name} required onCommit={(name) => update({ name })} />
          <SelectField label="Kind" value={system.template} options={TEMPLATE_LABELS} onCommit={(template) => update({ template })} />
          <ColorField label="Power system color" value={system.color} onCommit={(color) => update({ color })} />
        </div>
        <TextField label="What it is" value={system.summary} placeholder="In a line: what this power is" onCommit={(summary) => update({ summary })} />
        <AgeTabs worldId={worldId} eras={eras} ages={own} nowEra={nowEra} tab={era ? era.id : ALWAYS} onTab={setTab} />
        {era ? <AgePanel key={era.id} system={system} era={era} age={own.find((a) => a.eraId === era.id)} /> : <AlwaysPanel system={system} update={update} />}
      </section>
    </div>
  )
}

/** "Always", then each era in time order with how strong the system is then; the playhead's era is marked. */
function AgeTabs({ worldId, eras, ages, nowEra, tab, onTab }: { worldId: string; eras: Era[]; ages: PowerAge[]; nowEra: Era | undefined; tab: string; onTab(id: string): void }) {
  const cal = useCalendar(worldId)
  const playhead = usePlayhead(worldId)
  const strength = (eraId: string) => ages.find((a) => a.eraId === eraId)?.strength ?? null
  const addAge = () => void execute({ type: 'era.create', payload: { ownerId: worldId, name: 'New age', start: playhead, end: playhead + 100 * secondsPerYear(cal) } })
  return (
    <div className="field">
      <span>Ages</span>
      <div className="power-ages" role="tablist" aria-label="Ages">
        <button role="tab" aria-selected={tab === ALWAYS} onClick={() => onTab(ALWAYS)}>
          <b>Always</b>
          <span className="muted small">every age</span>
        </button>
        {eras.map((e) => {
          const s = strength(e.id)
          return (
            <button key={e.id} role="tab" aria-selected={tab === e.id} onClick={() => onTab(e.id)} title={s === null ? 'How strong it is then isn’t said' : `${Math.round(s * 100)}% strength`}>
              <b>
                {e.name}
                {e.id === nowEra?.id && <span className="badge">now</span>}
              </b>
              <span className="muted small">
                {formatTime(e.start, 'year', cal)} – {formatTime(e.end, 'year', cal)}
              </span>
              <span className="power-strength" aria-hidden>
                <span style={{ width: s === null ? 0 : `${s * 100}%` }} />
              </span>
            </button>
          )
        })}
      </div>
      {eras.length === 0 && (
        <p className="muted small">
          This world has no ages yet. Each era on the timeline is one: add them there (+ Era), or{' '}
          <button className="link accent" onClick={addAge}>
            add an age at the playhead
          </button>
          .
        </p>
      )}
    </div>
  )
}

/** What's true in every age, the questions it answers, and notes. */
function AlwaysPanel({ system, update }: { system: PowerSystem; update(patch: PowerPatch): void }) {
  return (
    <div className="powers-age" role="tabpanel" aria-label="Always">
      {system.aspects.map((a) => (
        <TextAreaField
          key={a.id}
          label={a.label}
          value={system.values[a.id] ?? ''}
          placeholder="True in every age, unless an age says otherwise"
          onCommit={(v) => update({ values: withValue(system.values, a.id, v) })}
        />
      ))}
      <AspectsEditor system={system} update={update} />
      <NotesField label="Power system notes" value={system.notes} onCommit={(notes) => update({ notes })} />
      <DeleteButton kind="power" ids={[system.id]}>
        Delete power system
      </DeleteButton>
    </div>
  )
}

/** Renaming, removing and adding the questions a system answers. An answer stays with its question when it's renamed. */
function AspectsEditor({ system, update }: { system: PowerSystem; update(patch: PowerPatch): void }) {
  const [label, setLabel] = useState('')
  const add = () => {
    const name = label.trim()
    if (!name) return
    update({
      aspects: [
        ...system.aspects,
        {
          id: aspectId(
            name,
            system.aspects.map((a) => a.id)
          ),
          label: name
        }
      ]
    })
    setLabel('')
  }
  return (
    <details className="field">
      <summary>Questions it answers</summary>
      <ul className="plain-list power-aspects" aria-label="Questions it answers">
        {system.aspects.map((a) => (
          <li key={a.id}>
            <TextField label={`Question ${a.label}`} value={a.label} required onCommit={(next) => update({ aspects: system.aspects.map((x) => (x.id === a.id ? { ...x, label: next } : x)) })} />
            <button className="link" aria-label={`Remove question ${a.label}`} onClick={() => update({ aspects: system.aspects.filter((x) => x.id !== a.id) })}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="field-row">
        <input aria-label="New question" placeholder="Another question it answers" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button onClick={add} disabled={!label.trim()}>
          Add
        </button>
      </div>
    </details>
  )
}

/** A system in one era: what's different then (blank keeps what's always true), and how strong it is. */
function AgePanel({ system, era, age }: { system: PowerSystem; era: Era; age: PowerAge | undefined }) {
  const set = (patch: PowerAgePatch) => void execute({ type: 'powerAge.set', payload: { systemId: system.id, eraId: era.id, patch } })
  const values = age?.values ?? {}
  const strength = age?.strength ?? null
  return (
    <div className="powers-age" role="tabpanel" aria-label={era.name}>
      <TextField label={`In ${era.name}`} value={age?.summary ?? ''} placeholder={system.summary || 'In a line: how things stand in this age'} onCommit={(summary) => set({ summary })} />
      {strength === null ? (
        <button className="link accent power-say-strength" onClick={() => set({ strength: 0.5 })}>
          Say how strong it is in {era.name}
        </button>
      ) : (
        <div className="power-strength-field">
          <CommitSlider label={`Strength in ${era.name}`} unit="%" min={0} max={100} step={5} value={Math.round(strength * 100)} onCommit={(v) => set({ strength: v / 100 })} />
          <button className="link" onClick={() => set({ strength: null })}>
            Clear
          </button>
        </div>
      )}
      {system.aspects.map((a) => {
        const always = system.values[a.id]
        return (
          <TextAreaField
            key={a.id}
            label={a.label}
            value={values[a.id] ?? ''}
            placeholder={always ? `As always: ${always}` : 'Nothing said yet'}
            onCommit={(v) => set({ values: withValue(values, a.id, v) })}
          />
        )
      })}
      {age && (
        <button className="danger" onClick={() => void execute({ type: 'powerAge.delete', payload: { id: age.id } })}>
          Forget {era.name} for {system.name}
        </button>
      )}
    </div>
  )
}
