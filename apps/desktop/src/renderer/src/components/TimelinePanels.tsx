import { LINK_TYPES, PRECISIONS, type Era, type EventGroup, type EventLink, type LinkType, type Precision, type TimelineEvent } from '@universe/core'
import { updater, useUi, type TimelineSelection } from '../store'
import { locationLabel } from '../timeline/labels'
import { useEditor } from '../world/editorStore'
import { ColorField, TagsField, TextField, TimeField } from './fields'
import { EventEffects } from './EventEffects'
import { NotesEditor } from './NotesEditor'

const PRECISION_LABELS: Record<Precision, string> = { exact: 'Exact time', day: 'Day', year: 'Year', century: 'Century', approx: 'Approximate' }
const LINK_LABELS: Record<LinkType, [string, string]> = {
  causes: ['causes', 'caused by'],
  enables: ['enables', 'enabled by'],
  prevents: ['prevents', 'prevented by'],
  precedes: ['precedes', 'preceded by'],
  related: ['related to', 'related to']
}

/** Inspector section for what's selected on the timeline. */
export function TimelineInspector({ selection }: { selection: TimelineSelection }) {
  const timeline = useUi((s) => s.timeline)
  if (selection.kind === 'event' && selection.ids.length > 1) return <MultiEventPanel ids={selection.ids} />
  const id = selection.ids[0]!
  const find = <T extends { id: string }>(list: T[]) => list.find((r) => r.id === id)
  const record = find(timeline[`${selection.kind}s`] as { id: string; updatedAt: string }[])
  if (!record) return null
  const key = `${record.id}:${record.updatedAt}`
  switch (selection.kind) {
    case 'event':
      return <EventPanel key={key} event={record as TimelineEvent} />
    case 'era':
      return <EraPanel key={key} era={record as Era} />
    case 'group':
      return <GroupPanel key={key} group={record as EventGroup} />
    case 'link':
      return <LinkPanel key={key} link={record as EventLink} />
    default:
      return null
  }
}

function PanelHeader({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="inspector-kind">
      {icon} {label}
      <button className="link close" aria-label={`Close ${label.toLowerCase()}`} onClick={() => useUi.getState().selectTimeline(null)}>
        ✕
      </button>
    </div>
  )
}

function EventPanel({ event }: { event: TimelineEvent }) {
  const { execute } = useUi.getState()
  const timeline = useUi((s) => s.timeline)
  const regions = useUi((s) => s.regions)
  const owner = useUi((s) => s.nodes.find((n) => n.id === event.ownerId))
  const update = updater('event', event.id)
  const lanes = timeline.lanes.filter((l) => l.ownerId === event.ownerId).sort((a, b) => a.order - b.order)
  const others = timeline.events.filter((e) => e.ownerId === event.ownerId && e.id !== event.id)
  const title = (id: string) => timeline.events.find((e) => e.id === id)?.title ?? '?'
  const links = timeline.links.filter((l) => l.fromId === event.id || l.toId === event.id)
  const group = timeline.groups.find((g) => g.id === event.groupId)
  const worldRegions = regions.filter((r) => r.worldId === event.ownerId)
  const onWorld = owner?.kind === 'world'

  return (
    <section className="inspector-section" aria-label="Event">
      <PanelHeader icon="◆" label="Event" />
      <TextField label="Event title" value={event.title} required onCommit={(t) => update({ title: t })} />
      <div className="field-pair">
        <label className="field">
          <span>Starts</span>
          <TimeField label="Starts" value={event.start} precision={event.precision} onCommit={(v) => v && update({ start: v.t, precision: v.precision, ...(event.end !== null && event.end < v.t ? { end: v.t } : {}) })} />
        </label>
        <label className="field">
          <span>Ends</span>
          <TimeField label="Ends" value={event.end} precision={event.precision} allowEmpty placeholder="— a moment" onCommit={(v) => update({ end: v ? Math.max(v.t, event.start) : null })} />
        </label>
      </div>
      <div className="field-pair">
        <label className="field">
          <span>Precision</span>
          <select value={event.precision} onChange={(e) => update({ precision: e.target.value as Precision })}>
            {PRECISIONS.map((p) => (
              <option key={p} value={p}>
                {PRECISION_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Lane</span>
          <select value={event.laneId ?? ''} onChange={(e) => update({ laneId: e.target.value || null })}>
            <option value="">Events</option>
            {lanes.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ColorField label="Event color" value={event.color} onCommit={(color) => update({ color })} />

      {onWorld && (
        <div className="field">
          <span>Where</span>
          {event.locations.length === 0 && <p className="muted small">Nowhere yet.</p>}
          <ul className="chip-list">
            {event.locations.map((loc, i) => (
              <li key={i}>
                {locationLabel(loc, regions)}
                <button className="link" aria-label="Remove location" onClick={() => update({ locations: event.locations.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <div className="add-buttons">
            <button
              title="Then click the globe or map"
              onClick={() => {
                // Show the world surface (e.g. when its planet is selected) without losing the event selection.
                useUi.setState({ selectedId: event.ownerId })
                useEditor.getState().set({ tool: 'locate', locateEventId: event.id, draft: [] })
              }}
            >
              📍 Pick on map
            </button>
            {worldRegions.length > 0 && (
              <select
                aria-label="Add region"
                value=""
                onChange={(e) => e.target.value && update({ locations: [...event.locations, { kind: 'region', regionId: e.target.value }] })}
              >
                <option value="">+ Region…</option>
                {worldRegions
                  .filter((r) => !event.locations.some((l) => l.kind === 'region' && l.regionId === r.id))
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            )}
          </div>
        </div>
      )}

      {onWorld && <EventEffects event={event} />}

      <div className="field">
        <span>Causes and effects</span>
        <ul className="link-list">
          {links.map((l) => {
            const outgoing = l.fromId === event.id
            return (
              <li key={l.id}>
                <select
                  aria-label="Link type"
                  value={l.type}
                  onChange={(e) => void execute({ type: 'link.update', payload: { id: l.id, patch: { type: e.target.value as LinkType } } })}
                >
                  {LINK_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {LINK_LABELS[t][outgoing ? 0 : 1]}
                    </option>
                  ))}
                </select>
                <button className="link" onClick={() => useUi.getState().selectTimeline({ kind: 'event', ids: [outgoing ? l.toId : l.fromId] })}>
                  {title(outgoing ? l.toId : l.fromId)}
                </button>
                <button className="link" aria-label="Remove link" onClick={() => void execute({ type: 'link.delete', payload: { id: l.id } })}>
                  ✕
                </button>
              </li>
            )
          })}
        </ul>
        {others.length > 0 && (
          <select aria-label="Link to event" value="" onChange={(e) => e.target.value && void execute({ type: 'link.create', payload: { fromId: event.id, toId: e.target.value } })}>
            <option value="">+ Causes…</option>
            {others
              .filter((o) => !links.some((l) => l.toId === o.id || l.fromId === o.id))
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
          </select>
        )}
      </div>

      {group && (
        <div className="field">
          <span>Group</span>
          <div className="field-row">
            <button className="link" onClick={() => useUi.getState().selectTimeline({ kind: 'group', ids: [group.id] })}>
              {group.title}
            </button>
            <button onClick={() => update({ groupId: null })}>Remove from group</button>
          </div>
        </div>
      )}

      <TagsField label="Event tags" tags={event.tags} onCommit={(tags) => update({ tags })} />
      <div className="field">
        <span>Event notes</span>
        <NotesEditor label="Event notes" value={event.notes} onCommit={(notes) => update({ notes })} />
      </div>
      <button className="danger" onClick={() => void execute({ type: 'event.delete', payload: { id: event.id } })}>
        Delete event
      </button>
    </section>
  )
}

function MultiEventPanel({ ids }: { ids: string[] }) {
  const { execute } = useUi.getState()
  const ownerId = useUi((s) => s.timeline.events.find((e) => e.id === ids[0])?.ownerId)
  return (
    <section className="inspector-section" aria-label="Events">
      <PanelHeader icon="◆" label={`${ids.length} events`} />
      <p className="muted small">Group them to show them as one bar that can be collapsed.</p>
      <div className="add-buttons">
        <button onClick={() => ownerId && void execute({ type: 'group.create', payload: { ownerId, eventIds: ids } })}>Group events</button>
        <button className="danger" onClick={() => void execute({ type: 'batch', payload: { commands: ids.map((id) => ({ type: 'event.delete', payload: { id } })) } })}>
          Delete events
        </button>
      </div>
    </section>
  )
}

function EraPanel({ era }: { era: Era }) {
  const { execute } = useUi.getState()
  const update = updater('era', era.id)
  return (
    <section className="inspector-section" aria-label="Era">
      <PanelHeader icon="▭" label="Era" />
      <TextField label="Era name" value={era.name} required onCommit={(name) => update({ name })} />
      <div className="field-pair">
        <label className="field">
          <span>From</span>
          <TimeField label="Era start" value={era.start} precision="year" onCommit={(v) => v && update({ start: Math.min(v.t, era.end) })} />
        </label>
        <label className="field">
          <span>To</span>
          <TimeField label="Era end" value={era.end} precision="year" onCommit={(v) => v && update({ end: Math.max(v.t, era.start) })} />
        </label>
      </div>
      <ColorField label="Era color" value={era.color} onCommit={(color) => update({ color })} />
      <div className="field">
        <span>Era notes</span>
        <NotesEditor label="Era notes" value={era.notes} onCommit={(notes) => update({ notes })} />
      </div>
      <button className="danger" onClick={() => void execute({ type: 'era.delete', payload: { id: era.id } })}>
        Delete era
      </button>
    </section>
  )
}

function GroupPanel({ group }: { group: EventGroup }) {
  const { execute, selectTimeline } = useUi.getState()
  const events = useUi((s) => s.timeline.events)
  const members = events.filter((e) => e.groupId === group.id)
  const update = updater('group', group.id)
  return (
    <section className="inspector-section" aria-label="Group">
      <PanelHeader icon="▤" label="Group" />
      <TextField label="Group title" value={group.title} required onCommit={(title) => update({ title })} />
      <ColorField label="Group color" value={group.color} onCommit={(color) => update({ color })} />
      <label className="checkbox">
        <input type="checkbox" checked={group.collapsed} onChange={(e) => update({ collapsed: e.target.checked })} /> Collapsed into one bar
      </label>
      <div className="field">
        <span>Events</span>
        <ul className="region-list">
          {members.map((e) => (
            <li key={e.id}>
              <button className="link region-row" onClick={() => selectTimeline({ kind: 'event', ids: [e.id] })}>
                <span className="swatch" style={{ background: e.color }} />
                {e.title}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="field">
        <span>Group notes</span>
        <NotesEditor label="Group notes" value={group.notes} onCommit={(notes) => update({ notes })} />
      </div>
      <button className="danger" onClick={() => void execute({ type: 'group.delete', payload: { id: group.id } })}>
        Ungroup
      </button>
    </section>
  )
}

function LinkPanel({ link }: { link: EventLink }) {
  const { execute, selectTimeline } = useUi.getState()
  const events = useUi((s) => s.timeline.events)
  const title = (id: string) => events.find((e) => e.id === id)?.title ?? '?'
  return (
    <section className="inspector-section" aria-label="Link">
      <PanelHeader icon="→" label="Link" />
      <p className="link-sentence">
        <button className="link" onClick={() => selectTimeline({ kind: 'event', ids: [link.fromId] })}>
          {title(link.fromId)}
        </button>{' '}
        <select aria-label="Link type" value={link.type} onChange={(e) => void execute({ type: 'link.update', payload: { id: link.id, patch: { type: e.target.value as LinkType } } })}>
          {LINK_TYPES.map((t) => (
            <option key={t} value={t}>
              {LINK_LABELS[t][0]}
            </option>
          ))}
        </select>{' '}
        <button className="link" onClick={() => selectTimeline({ kind: 'event', ids: [link.toId] })}>
          {title(link.toId)}
        </button>
      </p>
      <TextField label="Link note" value={link.note} onCommit={(note) => void execute({ type: 'link.update', payload: { id: link.id, patch: { note } } })} />
      <button className="danger" onClick={() => void execute({ type: 'link.delete', payload: { id: link.id } })}>
        Delete link
      </button>
    </section>
  )
}
