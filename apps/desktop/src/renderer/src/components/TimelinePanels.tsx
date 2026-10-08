import { LINK_TYPES, PRECISIONS, type Era, type EventGroup, type EventLink, type LinkType, type Precision, type Theme, type ThemeSpan, type TimelineEvent } from '@universe/core'
import { useMemo } from 'react'
import { updater, useEventsById, useOwnRecords, useUi, type TimelineSelection } from '../store'
import { locationLabel } from '../timeline/labels'
import { useEditor } from '../world/editorStore'
import { ColorField, DeleteButton, NotesField, PanelHeader, SwatchList, TagsField, TextField, TimeField } from './fields'
import { EventEffects } from './EventEffects'
import { ThemePanel, ThemeSpanPanel } from './ThemePanels'

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
  // A panel per record; its fields show new stored values (undo, an edit elsewhere) themselves.
  const key = record.id
  switch (selection.kind) {
    case 'event':
      return <EventPanel key={key} event={record as TimelineEvent} />
    case 'era':
      return <EraPanel key={key} era={record as Era} />
    case 'group':
      return <GroupPanel key={key} group={record as EventGroup} />
    case 'link':
      return <LinkPanel key={key} link={record as EventLink} />
    case 'theme':
      return <ThemePanel key={key} theme={record as Theme} />
    case 'themeSpan':
      return <ThemeSpanPanel key={key} span={record as ThemeSpan} />
    default:
      return null
  }
}

const closePanel = () => useUi.getState().selectTimeline(null)

function EventPanel({ event }: { event: TimelineEvent }) {
  const { execute } = useUi.getState()
  const ownLanes = useOwnRecords('lanes', event.ownerId)
  const ownEvents = useOwnRecords('events', event.ownerId)
  const allLinks = useUi((s) => s.timeline.links)
  const group = useUi((s) => s.timeline.groups.find((g) => g.id === event.groupId))
  const regions = useUi((s) => s.regions)
  const owner = useUi((s) => s.nodes.find((n) => n.id === event.ownerId))
  const update = updater('event', event.id)
  const lanes = useMemo(() => [...ownLanes].sort((a, b) => a.order - b.order), [ownLanes])
  const eventsById = useEventsById()
  const title = (id: string) => eventsById.get(id)?.title ?? '?'
  const links = useMemo(() => allLinks.filter((l) => l.fromId === event.id || l.toId === event.id), [allLinks, event.id])
  const hasOthers = ownEvents.some((e) => e.id !== event.id)
  // The events it could go on to cause, made once (a timeline can have thousands), not linked to it yet.
  const causeOptions = useMemo(() => {
    const linked = new Set(links.flatMap((l) => [l.fromId, l.toId]))
    return ownEvents
      .filter((o) => o.id !== event.id && !linked.has(o.id))
      .map((o) => (
        <option key={o.id} value={o.id}>
          {o.title}
        </option>
      ))
  }, [ownEvents, links, event.id])
  const worldRegions = regions.filter((r) => r.worldId === event.ownerId)
  const onWorld = owner?.kind === 'world'

  return (
    <section className="inspector-section" aria-label="Event">
      <PanelHeader icon="◆" label="Event" onClose={closePanel} />
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
        {hasOthers && (
          <select aria-label="Link to event" value="" onChange={(e) => e.target.value && void execute({ type: 'link.create', payload: { fromId: event.id, toId: e.target.value } })}>
            <option value="">+ Causes…</option>
            {causeOptions}
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
      <NotesField label="Event notes" value={event.notes} onCommit={(notes) => update({ notes })} />
      <DeleteButton kind="event" ids={[event.id]}>
        Delete event
      </DeleteButton>
    </section>
  )
}

function MultiEventPanel({ ids }: { ids: string[] }) {
  const { execute } = useUi.getState()
  const ownerId = useUi((s) => s.timeline.events.find((e) => e.id === ids[0])?.ownerId)
  return (
    <section className="inspector-section" aria-label="Events">
      <PanelHeader icon="◆" label={`${ids.length} events`} onClose={closePanel} />
      <p className="muted small">Group them to show them as one bar that can be collapsed.</p>
      <div className="add-buttons">
        <button onClick={() => ownerId && void execute({ type: 'group.create', payload: { ownerId, eventIds: ids } })}>Group events</button>
        <DeleteButton kind="event" ids={ids}>
          Delete events
        </DeleteButton>
      </div>
    </section>
  )
}

function EraPanel({ era }: { era: Era }) {
  const update = updater('era', era.id)
  return (
    <section className="inspector-section" aria-label="Era">
      <PanelHeader icon="▭" label="Era" onClose={closePanel} />
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
      <NotesField label="Era notes" value={era.notes} onCommit={(notes) => update({ notes })} />
      <DeleteButton kind="era" ids={[era.id]}>
        Delete era
      </DeleteButton>
    </section>
  )
}

function GroupPanel({ group }: { group: EventGroup }) {
  const { selectTimeline } = useUi.getState()
  const events = useUi((s) => s.timeline.events)
  const members = events.filter((e) => e.groupId === group.id)
  const update = updater('group', group.id)
  return (
    <section className="inspector-section" aria-label="Group">
      <PanelHeader icon="▤" label="Group" onClose={closePanel} />
      <TextField label="Group title" value={group.title} required onCommit={(title) => update({ title })} />
      <ColorField label="Group color" value={group.color} onCommit={(color) => update({ color })} />
      <label className="checkbox">
        <input type="checkbox" checked={group.collapsed} onChange={(e) => update({ collapsed: e.target.checked })} /> Collapsed into one bar
      </label>
      <div className="field">
        <span>Events</span>
        <SwatchList rows={members.map((e) => ({ id: e.id, name: e.title, color: e.color }))} onPick={(id) => selectTimeline({ kind: 'event', ids: [id] })} />
      </div>
      <NotesField label="Group notes" value={group.notes} onCommit={(notes) => update({ notes })} />
      <DeleteButton kind="group" ids={[group.id]}>
        Ungroup
      </DeleteButton>
    </section>
  )
}

function LinkPanel({ link }: { link: EventLink }) {
  const { execute, selectTimeline } = useUi.getState()
  const eventsById = useEventsById()
  const title = (id: string) => eventsById.get(id)?.title ?? '?'
  return (
    <section className="inspector-section" aria-label="Link">
      <PanelHeader icon="→" label="Link" onClose={closePanel} />
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
      <DeleteButton kind="link" ids={[link.id]}>
        Delete link
      </DeleteButton>
    </section>
  )
}
