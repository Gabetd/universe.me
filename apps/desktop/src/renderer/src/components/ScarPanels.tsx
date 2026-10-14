import { SCAR_KINDS, SCAR_LOOKS, eventPlace, scarName, scarWeight, secondsPerYear, sphericalMean, type Scar, type ScarKind, type TimelineEvent } from '@universe/core'
import { useMemo, useState } from 'react'
import { updater, useOwnRecords, useUi, useWorld } from '../store'
import { usePlayhead } from '../timeline/timelineStore'
import { latLonLabel } from '../world/useMapPins'
import { selectScar, useSelectedScarId } from '../world/useScars'
import { useCalendar } from '../world/useSky'
import { CommitSlider, DeleteButton, NotesField, NumberInput, PanelHeader, SelectField, SwatchList, TextField, TimeField } from './fields'

/**
 * Scars on a world's land (core scars.ts) in the inspector: a scar's own
 * panel, the world's list of them, and an event's (the scars it left).
 */

const KIND_OPTIONS = Object.fromEntries(SCAR_KINDS.map((k) => [k, `${SCAR_LOOKS[k].icon} ${SCAR_LOOKS[k].label}`])) as Record<ScarKind, string>

/** How much of a scar there is at the playhead, in words. */
function useScarNow(scar: Scar): string {
  const playhead = usePlayhead(scar.ownerId)
  const year = secondsPerYear(useCalendar(scar.ownerId))
  const now = scarWeight(scar, playhead, year)
  if (playhead < scar.start) return 'Not yet, at the playhead.'
  if (now <= 0) return 'Healed, at the playhead.'
  const share = `${Math.round((now / Math.max(scar.strength, 1e-6)) * 100)}%`
  return scar.end !== null && playhead > scar.end ? `Healing, at the playhead: ${share} of it left.` : 'At its worst, at the playhead.'
}

/** A scar: what it is, where and how far it reaches, when it comes, ends and heals, how bad it is, what made it, and its notes. */
export function ScarPanel({ scar }: { scar: Scar }) {
  const update = updater('scar', scar.id)
  const look = SCAR_LOOKS[scar.kind]
  const { regions } = useWorld(scar.ownerId)
  const events = useOwnRecords('events', scar.ownerId)
  const now = useScarNow(scar)
  const overRegion = (regionId: string) => {
    const region = regions.find((r) => r.id === regionId)
    update(region ? { regionId, ...sphericalMean(region.points) } : { regionId: null })
  }
  return (
    <section className="inspector-section" aria-label="Scar">
      <PanelHeader icon={look.icon} label="Scar" onClose={() => useUi.getState().selectTimeline(null)} />
      <TextField label="Scar name" value={scar.name} placeholder={look.label} onCommit={(name) => update({ name })} />
      <SelectField label="Kind of scar" value={scar.kind} options={KIND_OPTIONS} onCommit={(kind) => update({ kind })} />
      <p className="muted small" aria-label="Scar now">
        {now}
      </p>
      <label className="field">
        <span>Where</span>
        <select aria-label="Scar over" value={scar.regionId ?? ''} onChange={(e) => overRegion(e.target.value)}>
          <option value="">Around {latLonLabel(scar)}</option>
          {regions.map((r) => (
            <option key={r.id} value={r.id}>
              Over {r.name}
            </option>
          ))}
        </select>
      </label>
      {!scar.regionId && (
        <label className="field">
          <span>Reaches (km around)</span>
          <NumberInput value={scar.radiusKm} min={0.01} max={20_000} onCommit={(radiusKm) => update({ radiusKm })} />
        </label>
      )}
      <div className="field-row">
        <TimeField label="Comes" value={scar.start} precision="year" onCommit={(v) => v && update({ start: v.t, ...(scar.end !== null && scar.end < v.t ? { end: v.t } : {}) })} />
        <TimeField label="Worst until" value={scar.end} precision="year" allowEmpty placeholder="— for good" onCommit={(v) => update({ end: v ? Math.max(v.t, scar.start) : null })} />
      </div>
      <label className="field">
        <span>Heals over (years; 0 never)</span>
        <NumberInput value={scar.recoverYears} min={0} max={10_000_000} onCommit={(recoverYears) => update({ recoverYears })} />
      </label>
      <CommitSlider label="How bad" unit="%" min={5} max={100} step={5} value={Math.round(scar.strength * 100)} onCommit={(v) => update({ strength: v / 100 })} />
      {look.damage > 0 && <p className="muted small">It damages what’s built where it reaches as it comes{scar.kind === 'crater' ? ', and destroys what’s at its heart' : ''}.</p>}
      <label className="field">
        <span>Made by</span>
        <select aria-label="Made by event" value={scar.eventId ?? ''} onChange={(e) => update({ eventId: e.target.value || null })}>
          <option value="">No event</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </select>
      </label>
      <NotesField label="Scar notes" value={scar.notes} onCommit={(notes) => update({ notes })} />
      <DeleteButton kind="scar" ids={[scar.id]}>
        Delete scar
      </DeleteButton>
    </section>
  )
}

/** Rows for a list of scars, dimmed where there's none of it at the playhead. */
function useScarRows(scars: Scar[], worldId: string) {
  const playhead = usePlayhead(worldId)
  const year = secondsPerYear(useCalendar(worldId))
  const selectedId = useSelectedScarId()
  return useMemo(
    () =>
      scars.map((s) => ({
        id: s.id,
        name: `${SCAR_LOOKS[s.kind].icon} ${scarName(s)}`,
        color: SCAR_LOOKS[s.kind].color,
        selected: s.id === selectedId,
        absent: scarWeight(s, playhead, year) > 0 ? undefined : playhead < s.start ? 'Not yet, at the playhead' : 'Healed, at the playhead'
      })),
    [scars, playhead, year, selectedId]
  )
}

/** A world's scars, in the world's inspector. */
export function ScarList({ worldId }: { worldId: string }) {
  const scars = useOwnRecords('scars', worldId)
  const rows = useScarRows(scars, worldId)
  return (
    <section className="inspector-section" aria-label="Scars on the land">
      <h3>Scars on the land</h3>
      {scars.length === 0 ? (
        <p className="muted small">None yet. Pick the 💥 tool and click the world to leave a crater, war, fire, drought, radiation or poison there, or leave one from an event.</p>
      ) : (
        <SwatchList rows={rows} onPick={selectScar} menu="scar" />
      )}
    </section>
  )
}

/** The scars an event left, in its panel, and one more of a kind where it happened, from its start to its end. */
export function EventScars({ event }: { event: TimelineEvent }) {
  const all = useOwnRecords('scars', event.ownerId)
  const scars = useMemo(() => all.filter((s) => s.eventId === event.id), [all, event.id])
  const rows = useScarRows(scars, event.ownerId)
  const regions = useUi((s) => s.regions)
  const [kind, setKind] = useState<ScarKind>('crater')
  const place = eventPlace(event, regions)
  const leave = async () => {
    if (!place) return
    const look = SCAR_LOOKS[kind]
    // Over the region it happened in, if that's where; else around its point.
    const region = event.locations.find((l) => l.kind === 'region')
    const state = await useUi.getState().execute({
      type: 'scar.create',
      payload: {
        ownerId: event.ownerId,
        kind,
        ...place,
        regionId: region?.kind === 'region' ? region.regionId : null,
        eventId: event.id,
        start: event.start,
        end: event.end ?? (look.lasting ? null : event.start)
      }
    })
    const id = state?.focus?.id
    if (id) selectScar(id)
  }
  return (
    <div className="field" aria-label="Scars on the land">
      <span>Scars it left on the land</span>
      {scars.length > 0 && <SwatchList rows={rows} onPick={selectScar} menu="scar" />}
      <div className="field-row">
        <select aria-label="Scar to leave" value={kind} onChange={(e) => setKind(e.target.value as ScarKind)}>
          {SCAR_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_OPTIONS[k]}
            </option>
          ))}
        </select>
        <button disabled={!place} title={place ? undefined : 'Place the event on the world first'} onClick={() => void leave()}>
          Leave a scar
        </button>
      </div>
    </div>
  )
}
