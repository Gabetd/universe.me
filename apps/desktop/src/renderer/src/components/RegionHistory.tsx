import { formatTime, type EntityChange, type Region } from '@universe/core'
import { useState } from 'react'
import { useUi } from '../store'
import { usePlayhead } from '../timeline/timelineStore'
import { useCalendar } from '../world/useSky'
import { TimeField } from './fields'

/**
 * A region's history (EntityChange records): when it was founded and
 * dissolved, and renames or recolors along the way, each optionally caused
 * by an event. The map shows the region as of the timeline's playhead.
 */
export function RegionHistory({ region }: { region: Region }) {
  const { execute } = useUi.getState()
  const changes = useUi((s) => s.timeline.changes)
  const events = useUi((s) => s.timeline.events)
  const playhead = usePlayhead(region.worldId)
  const cal = useCalendar(region.worldId)
  const [newName, setNewName] = useState('')
  const own = changes.filter((c) => c.entityId === region.id).sort((a, b) => a.at - b.at)
  const worldEvents = events.filter((e) => e.ownerId === region.worldId)

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
      {worldEvents.map((e) => (
        <option key={e.id} value={e.id}>
          {e.title}
        </option>
      ))}
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
              {c.patch.color && <span className="swatch" style={{ background: c.patch.color }} />}
            </span>
            {causeSelect(c)}
            <button className="link" aria-label="Remove change" onClick={() => void execute({ type: 'change.delete', payload: { id: c.id } })}>
              ✕
            </button>
          </div>
        ))}
      <div className="field-row">
        <input aria-label="New name at playhead" placeholder={`New name in ${formatTime(playhead, 'year', cal)}`} value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button
          disabled={!newName.trim()}
          onClick={() => {
            void execute({ type: 'change.create', payload: { ownerId: region.worldId, entityKind: 'region', entityId: region.id, at: playhead, change: 'update', patch: { name: newName.trim() } } })
            setNewName('')
          }}
        >
          Rename then
        </button>
      </div>
    </div>
  )
}
