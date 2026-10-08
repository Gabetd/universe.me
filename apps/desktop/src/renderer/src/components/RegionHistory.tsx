import { formatTime, type Calendar, type EntityChange, type Region } from '@universe/core'
import { useMemo, useState } from 'react'
import { useOwnRecords, useUi } from '../store'
import { usePlayhead } from '../timeline/timelineStore'
import { useCalendar } from '../world/useSky'
import { Swatch, TimeField } from './fields'

/**
 * A region's history (EntityChange records): when it was founded and
 * dissolved, and renames or recolors along the way, each optionally caused
 * by an event. The map shows the region as of the timeline's playhead.
 */
export function RegionHistory({ region }: { region: Region }) {
  const { execute } = useUi.getState()
  const changes = useUi((s) => s.timeline.changes)
  const worldEvents = useOwnRecords('events', region.worldId)
  const cal = useCalendar(region.worldId)
  const own = useMemo(() => changes.filter((c) => c.entityId === region.id).sort((a, b) => a.at - b.at), [changes, region.id])
  // Made once for every "Caused by" list: a world can have thousands of events.
  const eventOptions = useMemo(
    () =>
      worldEvents.map((e) => (
        <option key={e.id} value={e.id}>
          {e.title}
        </option>
      )),
    [worldEvents]
  )

  const setMilestone = (change: 'appear' | 'vanish', existing: EntityChange | undefined, at: number | null) => {
    if (at === null) {
      if (existing) void execute({ type: 'change.delete', payload: { id: existing.id } })
    } else if (existing) {
      void execute({ type: 'change.update', payload: { id: existing.id, patch: { at } } })
    } else {
      void execute({ type: 'change.create', payload: { ownerId: region.worldId, entityKind: 'region', entityId: region.id, at, change } })
    }
  }

  const causeSelect = (c: EntityChange) => (
    <select
      aria-label="Caused by"
      value={c.causeEventId ?? ''}
      onChange={(e) => void execute({ type: 'change.update', payload: { id: c.id, patch: { causeEventId: e.target.value || null } } })}
    >
      <option value="">No cause</option>
      {eventOptions}
    </select>
  )

  const milestone = (change: 'appear' | 'vanish', label: string, placeholder: string) => {
    const existing = own.find((c) => c.change === change)
    return (
      <label className="field">
        <span>{label}</span>
        <div className="field-row">
          <TimeField label={label} value={existing?.at ?? null} precision="year" allowEmpty placeholder={placeholder} onCommit={(v) => setMilestone(change, existing, v?.t ?? null)} />
          {existing && causeSelect(existing)}
        </div>
      </label>
    )
  }

  return (
    <div className="field region-history">
      <span>History</span>
      {milestone('appear', 'Founded', 'Always existed')}
      {milestone('vanish', 'Dissolved', 'Still exists')}
      {own
        .filter((c) => c.change === 'update')
        .map((c) => (
          <div key={c.id} className="field-row small">
            <span>
              {formatTime(c.at, 'year', cal)}: {c.patch.name ? `renamed “${c.patch.name}”` : ''}
              {c.patch.color && <Swatch color={c.patch.color} />}
            </span>
            {causeSelect(c)}
            <button className="link" aria-label="Remove change" onClick={() => void execute({ type: 'change.delete', payload: { id: c.id } })}>
              ✕
            </button>
          </div>
        ))}
      <RenameAtPlayhead region={region} cal={cal} />
    </div>
  )
}

/** A new name from the playhead on. Its own component, so typing or moving the playhead doesn't redraw the history's lists. */
function RenameAtPlayhead({ region, cal }: { region: Region; cal: Calendar }) {
  const playhead = usePlayhead(region.worldId)
  const [newName, setNewName] = useState('')
  return (
    <div className="field-row">
      <input aria-label="New name at playhead" placeholder={`New name in ${formatTime(playhead, 'year', cal)}`} value={newName} onChange={(e) => setNewName(e.target.value)} />
      <button
        disabled={!newName.trim()}
        onClick={() => {
          void useUi.getState().execute({ type: 'change.create', payload: { ownerId: region.worldId, entityKind: 'region', entityId: region.id, at: playhead, change: 'update', patch: { name: newName.trim() } } })
          setNewName('')
        }}
      >
        Rename then
      </button>
    </div>
  )
}
