import { formatTime, sameParty, type Calendar, type Party, type SpatialNode } from '@universe/core'
import { memo, useMemo } from 'react'
import { openElement } from '../contextMenu'
import { byId, useOwnRecords, useUi, useWorld } from '../store'
import { TimeScale, type TimeRange } from './scale'
import { useTimelineView } from './timelineStore'
import { TrackRow } from './TrackRow'

/** Where a span is drawn, clipped to the view (an open end runs off it). */
function bar(scale: TimeScale, start: number | null, end: number | null, width: number): { left: number; width: number } | undefined {
  const x0 = start === null ? -1 : Math.max(-1, scale.x(start))
  const x1 = end === null ? width + 1 : Math.min(width + 1, scale.x(end))
  return x1 > x0 && x1 >= 0 && x0 <= width ? { left: x0, width: Math.max(2, x1 - x0) } : undefined
}

/**
 * A lane of their own for the characters and factions asked for (PLAN.md §9,
 * M14; from their panels): a character's life from birth to death, the
 * factions they belong to over it, the stops of their journey and the events
 * they take part in; a faction's span from founding to dissolution, the land
 * it holds and its events. Click an event to select it, the bar to open them.
 */
export const LivesTrack = memo(function LivesTrack({ owner, range, width, cal, labelWidth }: { owner: SpatialNode; range: TimeRange; width: number; cal: Calendar; labelWidth: number }) {
  const shown = useTimelineView((s) => s.lives[owner.id])
  const characters = useOwnRecords('characters', owner.id)
  const factions = useOwnRecords('factions', owner.id)
  const memberships = useOwnRecords('memberships', owner.id)
  const holdings = useOwnRecords('holdings', owner.id)
  const events = useOwnRecords('events', owner.id)
  const { regions } = useWorld(owner.id)
  const lives = useMemo(() => {
    if (!shown?.length) return []
    const [characterById, factionById, regionById] = [byId(characters), byId(factions), byId(regions)]
    return shown.flatMap((id) => {
      const character = characterById.get(id)
      const faction = factionById.get(id)
      const party: Party | undefined = character ? { kind: 'character', id } : faction ? { kind: 'faction', id } : undefined
      if (!party) return []
      const took = events.filter((e) => e.participants?.some((p) => sameParty(p, party)) || character?.stops.some((s) => s.eventId === e.id))
      if (character) {
        const parts = memberships.filter((m) => m.characterId === id).flatMap((m) => {
          const f = factionById.get(m.factionId)
          return f ? [{ id: m.id, start: m.start ?? character.born, end: m.end ?? character.died, color: f.color, title: `${f.name}${m.role ? `, ${m.role}` : ''}` }] : []
        })
        return [{ party, name: character.name, color: character.color, start: character.born, end: character.died, parts, events: took, stops: character.stops.map((s) => s.at) }]
      }
      const parts = holdings.filter((h) => h.factionId === id).map((h) => ({ id: h.id, start: h.start ?? faction!.start, end: h.end ?? faction!.end, color: faction!.color, title: regionById.get(h.regionId)?.name ?? 'A region' }))
      return [{ party, name: `${faction!.emblem ? `${faction!.emblem} ` : ''}${faction!.name}`, color: faction!.color, start: faction!.start, end: faction!.end, parts, events: took, stops: [] as number[] }]
    })
  }, [shown, characters, factions, memberships, holdings, events, regions])
  if (!lives.length) return null
  const scale = new TimeScale(range, width)
  const { selectTimeline } = useUi.getState()
  return (
    <>
      {lives.map((life) => (
        <TrackRow key={life.party.id} label={life.name} ariaLabel={`${life.name}’s lane`} labelWidth={labelWidth} className="tl-life">
          {(() => {
            const span = bar(scale, life.start, life.end, width)
            const when = `${life.start === null ? '…' : formatTime(life.start, 'year', cal)} – ${life.end === null ? '…' : formatTime(life.end, 'year', cal)}`
            return (
              span && (
                <button
                  className="tl-life-bar"
                  style={{ ...span, ['--c' as string]: life.color }}
                  title={`${life.name}: ${when}`}
                  aria-label={`${life.name}, ${when}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => openElement(life.party)}
                />
              )
            )
          })()}
          {life.parts.map((p) => {
            const span = bar(scale, p.start, p.end, width)
            return span && <span key={p.id} className="tl-life-part" style={{ ...span, background: p.color }} title={p.title} />
          })}
          {life.stops.map((at, i) => {
            const x = scale.x(at)
            return x >= 0 && x <= width && <span key={`${at}:${i}`} className="tl-life-stop" style={{ left: x }} title={`Arrives somewhere, ${formatTime(at, 'day', cal)}`} />
          })}
          {life.events.map((e) => {
            const x = scale.x(e.start)
            return (
              x >= 0 &&
              x <= width && (
                <button
                  key={e.id}
                  className="tl-life-event"
                  style={{ left: x, ['--c' as string]: e.color }}
                  title={`${e.title} · ${formatTime(e.start, e.precision, cal)}`}
                  aria-label={`${e.title}, in ${life.name}’s lane`}
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={() => selectTimeline({ kind: 'event', ids: [e.id] })}
                />
              )
            )
          })}
        </TrackRow>
      ))}
    </>
  )
})
