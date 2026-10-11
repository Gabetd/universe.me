import { waterwayKind, waterwayName, type Waterway } from '@universe/core'
import type { Lake, River } from '@universe/procgen'
import { useMemo, useState } from 'react'
import { useOwnRecords, useUi } from '../store'
import { useWater } from '../world/useWater'
import { RIVER_COLOR, viewUpClose } from '../world/waterLook'
import { NotesField, PanelHeader, Swatch, SwatchList, TextField } from './fields'

/**
 * A world's rivers and lakes (PLAN.md §9, M15): worked out from its terrain
 * (useWater), each with a name from the seed until it's given one of its own,
 * kept with its notes in a waterway record by its id.
 */

/** A world's rivers and lakes by id, with what's been given them. */
export function useWaterways(worldId: string) {
  const water = useWater(worldId)
  const own = useOwnRecords('waterways', worldId)
  return useMemo(() => {
    const given = new Map(own.map((w) => [w.key, w]))
    const byKey = new Map<string, River | Lake>()
    for (const r of water?.rivers ?? []) byKey.set(r.id, r)
    for (const l of water?.lakes ?? []) byKey.set(l.id, l)
    const nameOf = (key: string) => {
      const found = byKey.get(key)
      return found ? waterwayName(found.name, given.get(key)) : undefined
    }
    return { water, byKey, given, nameOf }
  }, [water, own])
}

/** Names a river or lake (its generated name back if it's given that, or nothing) or writes its notes. */
const setWaterway = (worldId: string, key: string, patch: Partial<Pick<Waterway, 'name' | 'notes'>>) =>
  void useUi.getState().execute({ type: 'waterway.set', payload: { worldId, key, patch } })

/** The selected river or lake: its name, what it is, where it ends or what runs into it, its notes, and going to see it. */
export function WaterwayPanel({ worldId, waterKey }: { worldId: string; waterKey: string }) {
  const { water, byKey, given, nameOf } = useWaterways(worldId)
  const found = byKey.get(waterKey)
  const select = useUi((s) => s.selectWaterway)
  const kind = waterwayKind(waterKey)
  const label = kind === 'lake' ? 'Lake' : 'River'
  if (!water) return <p className="muted small">Working out where the water runs…</p>
  if (!found) return null
  const own = given.get(waterKey)
  const name = waterwayName(found.name, own)
  const link = (key: string) => (
    <button className="link" onClick={() => select(key)}>
      {nameOf(key) ?? key}
    </button>
  )
  return (
    <section className="inspector-section" aria-label={label}>
      <PanelHeader icon={<Swatch color={RIVER_COLOR} />} label={label} onClose={() => select(null)} />
      <TextField label={`${label} name`} value={name} required onCommit={(next) => setWaterway(worldId, waterKey, { name: next === found.name ? '' : next })} />
      {own?.name && <p className="muted small">Named {found.name} when the world was made.</p>}
      <dl className="facts-list small" aria-label={`About the ${label.toLowerCase()}`}>
        {'points' in found ? (
          <>
            <dt>Length</dt>
            <dd>{found.lengthKm.toLocaleString()} km</dd>
            <dt>Runs into</dt>
            <dd>{found.into.kind === 'sea' ? 'the sea' : link(found.into.id)}</dd>
          </>
        ) : (
          <>
            <dt>Area</dt>
            <dd>{found.areaKm2.toLocaleString()} km²</dd>
            <dt>Surface</dt>
            <dd>{Math.round(found.level).toLocaleString()} m above the sea</dd>
          </>
        )}
        <Feeders water={water} waterKey={waterKey} link={link} />
      </dl>
      <div className="add-buttons">
        <button onClick={() => viewUpClose(found)}>🔍 View up close</button>
      </div>
      <NotesField label={`${label} notes`} value={own?.notes ?? ''} onCommit={(notes) => setWaterway(worldId, waterKey, { notes })} />
    </section>
  )
}

/** The rivers that run into a river or lake, biggest first. */
function Feeders({ water, waterKey, link }: { water: NonNullable<ReturnType<typeof useWater>>; waterKey: string; link(key: string): React.ReactNode }) {
  const feeders = water.rivers.filter((r) => r.into.kind !== 'sea' && r.into.id === waterKey)
  if (!feeders.length) return null
  return (
    <>
      <dt>Fed by</dt>
      <dd>
        {feeders.slice(0, 6).map((r, i) => (
          <span key={r.id}>
            {i > 0 && ', '}
            {link(r.id)}
          </span>
        ))}
        {feeders.length > 6 && ` and ${feeders.length - 6} more`}
      </dd>
    </>
  )
}

/** How many of each are listed before "Show all". */
const LISTED = 10

/** A world's rivers and lakes, the biggest first, to pick one. */
export function WaterwayList({ worldId }: { worldId: string }) {
  const { water, nameOf } = useWaterways(worldId)
  const selected = useUi((s) => s.selectedWaterwayKey)
  const select = useUi((s) => s.selectWaterway)
  const [all, setAll] = useState(false)
  const rows = (list: (River | Lake)[]) => list.slice(0, all ? list.length : LISTED).map((w) => ({ id: w.id, name: nameOf(w.id)!, color: RIVER_COLOR, selected: w.id === selected }))
  return (
    <section className="inspector-section" aria-label="Rivers and lakes">
      <h3>Rivers and lakes</h3>
      {!water ? (
        <p className="muted small">Working out where the water runs…</p>
      ) : (
        <>
          <p className="muted small">
            {water.rivers.length.toLocaleString()} rivers and {water.lakes.length.toLocaleString()} lakes, from where the land sends its rain. Click one to name it.
          </p>
          {(
            [
              ['Rivers', water.rivers],
              ['Lakes', water.lakes]
            ] as const
          ).map(
            ([label, list]) =>
              list.length > 0 && (
                <div key={label} role="group" aria-label={label}>
                  <h4 className="muted small">{label}</h4>
                  <SwatchList rows={rows(list)} onPick={select} menu="waterway" />
                </div>
              )
          )}
          {(water.rivers.length > LISTED || water.lakes.length > LISTED) && (
            <button className="link" onClick={() => setAll(!all)}>
              {all ? 'Show the biggest' : 'Show all'}
            </button>
          )}
        </>
      )}
    </section>
  )
}
