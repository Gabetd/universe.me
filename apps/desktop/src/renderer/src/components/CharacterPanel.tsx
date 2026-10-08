import { ageAt, characterAt, eventPlace, formatDuration, formatTime, isAlive, type Character } from '@universe/core'
import { useMemo } from 'react'
import { updater, useEventsById, useOwnRecords, useUi } from '../store'
import { usePlayhead, useTimelineView } from '../timeline/timelineStore'
import { useEditor } from '../world/editorStore'
import { useCalendar } from '../world/useSky'
import { sendCharacter } from '../world/sendCharacter'
import { ColorField, DeleteButton, NotesField, PanelHeader, Swatch, TagsField, TextField, TimeField } from './fields'

const latLon = (p: { lat: number; lon: number }) => `${Math.abs(p.lat).toFixed(3)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(3)}°${p.lon >= 0 ? 'E' : 'W'}`

/** Inspector for a character: their lifespan, where they are at the playhead, and their journey. */
export function CharacterPanel({ character }: { character: Character }) {
  const { selectCharacter } = useUi.getState()
  const worldEvents = useOwnRecords('events', character.ownerId)
  const regions = useUi((s) => s.regions)
  const playhead = usePlayhead(character.ownerId)
  const cal = useCalendar(character.ownerId)
  const update = updater('character', character.id)
  const place = characterAt(character, playhead)
  const alive = isAlive(character, playhead)
  // Events with a place on this world: somewhere to send them.
  const events = useMemo(() => worldEvents.map((e) => ({ event: e, place: eventPlace(e, regions) })).filter((x) => x.place), [worldEvents, regions])
  // Made once, not for every move of the playhead: a world can have thousands of events.
  const eventOptions = useMemo(
    () =>
      events.map(({ event }) => (
        <option key={event.id} value={event.id}>
          {formatTime(event.start, event.precision, cal)} · {event.title}
        </option>
      )),
    [events, cal]
  )
  const eventsById = useEventsById()
  const eventTitle = (id: string) => eventsById.get(id)?.title

  return (
    <section className="inspector-section region-form" aria-label="Character">
      <PanelHeader icon={<Swatch color={character.color} />} label="Character" onClose={() => selectCharacter(null)} />
      <TextField label="Character name" value={character.name} required onCommit={(name) => update({ name })} />
      <div className="field-pair">
        <label className="field">
          <span>Born</span>
          <TimeField label="Born" value={character.born} precision="year" onCommit={(v) => v && update({ born: v.t })} />
        </label>
        <label className="field">
          <span>Died</span>
          <TimeField label="Died" value={character.died} precision="year" allowEmpty placeholder="Still alive" onCommit={(v) => update({ died: v?.t ?? null })} />
        </label>
      </div>
      <p className="small" data-testid="character-status">
        {playhead < character.born
          ? `Not born yet at ${formatTime(playhead, 'year', cal)}.`
          : !alive
            ? `Died aged ${ageAt(character, playhead, cal)}.`
            : `Aged ${ageAt(character, playhead, cal)} at ${formatTime(playhead, 'year', cal)}${
                place ? (place.travelling ? `, on the way to stop ${place.stop + 1}` : `, at ${latLon(place)}`) : ', with nowhere to be yet'
              }.`}
      </p>
      <div className="add-buttons">
        <button
          disabled={!alive}
          title={alive ? 'Click on the world where they go; they arrive at the playhead' : 'Only the living travel'}
          onClick={() => useEditor.getState().startTool({ tool: 'travel', travelCharacterId: character.id })}
        >
          🧭 {character.stops.length ? 'Send to…' : 'Place…'}
        </button>
        {place && <button onClick={() => useEditor.getState().enterGround(place, 14)}>🔍 View up close</button>}
      </div>
      {events.length > 0 && (
        <select
          aria-label="Go to an event"
          value=""
          onChange={(e) => {
            const target = events.find((x) => x.event.id === e.target.value)
            if (target?.place) void sendCharacter(character.id, target.place, target.event.start, target.event.id)
          }}
        >
          <option value="">Go to an event…</option>
          {eventOptions}
        </select>
      )}

      <div className="field">
        <span>Journey</span>
        {character.stops.length === 0 ? (
          <p className="muted small">No stops yet. Use 🧭 to put them somewhere.</p>
        ) : (
          <ol className="plain-list small journey" aria-label="Journey">
            {character.stops.map((stop, i) => (
              <li key={`${stop.at}:${i}`}>
                <button className="link" title="Move the playhead here" onClick={() => useTimelineView.getState().setPlayhead(character.ownerId, stop.at)}>
                  {formatTime(stop.at, 'day', cal)}
                </button>{' '}
                {i === 0 ? 'starts at' : 'arrives at'} {latLon(stop)}
                {stop.eventId && <> for {eventTitle(stop.eventId) ?? 'an event'}</>}
                {i > 0 && stop.travel > 0 && <span className="muted"> after {formatDuration(Math.max(stop.travel, cal.secondsPerDay), cal)} on the road</span>}{' '}
                <button
                  className="link"
                  aria-label={`Remove stop ${i + 1}`}
                  onClick={() => update({ stops: character.stops.filter((_, j) => j !== i) })}
                >
                  ✕
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      <ColorField label="Character color" value={character.color} onCommit={(color) => update({ color })} />
      <TagsField label="Character tags" tags={character.tags} onCommit={(tags) => update({ tags })} />
      <NotesField label="Character notes" value={character.notes} onCommit={(notes) => update({ notes })} />
      <DeleteButton kind="character" ids={[character.id]}>
        Delete character
      </DeleteButton>
    </section>
  )
}
