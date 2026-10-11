import { RELATION_INFO, RELATION_TYPES, holdsAt, involves, otherParty, relationLabel, sameParty, type Membership, type Party, type Span } from '@universe/core'
import { useMemo, useState } from 'react'
import { menuRef, openElement, showFaction } from '../contextMenu'
import { useOwnRecords, useUi } from '../store'
import { usePlayhead, useTimelineView } from '../timeline/timelineStore'
import { TextField, TimeField } from './fields'

/**
 * Pieces of the factions pages (PLAN.md §9, M14) the character panel shares:
 * a span's dates, a list of memberships, and a list of relationships, each
 * row dimmed when it doesn't hold at the playhead.
 */

/** Runs a command through the bus (for the rows' edits, which need nothing back). */
export const execute = (command: Parameters<ReturnType<typeof useUi.getState>['execute']>[0]) => useUi.getState().execute(command)

/** From and until, as dates in the world's calendar; empty is "from the start" and "still". */
export function SpanFields({ span, label, from = 'From', until = 'Until', onCommit }: { span: Pick<Span, 'start' | 'end'>; label: string; from?: string; until?: string; onCommit(patch: Partial<Span>): void }) {
  return (
    <span className="span-fields">
      <TimeField label={`${label} ${from.toLowerCase()}`} value={span.start} precision="year" allowEmpty placeholder={from} onCommit={(v) => onCommit({ start: v?.t ?? null })} />
      <span className="muted">–</span>
      <TimeField label={`${label} ${until.toLowerCase()}`} value={span.end} precision="year" allowEmpty placeholder={until === 'Until' ? 'Still' : until} onCommit={(v) => onCommit({ end: v?.t ?? null })} />
    </span>
  )
}

/** A row's class: dimmed while it doesn't hold at the playhead. */
export const rowClass = (span: Pick<Span, 'start' | 'end'>, t: number) => `faction-row${holdsAt(span, t) ? '' : ' absent'}`

/** One membership, from either side (a faction's member, a character's faction): who or what, the role, when, and removing it. */
export function MembershipRow({ membership: m, playhead, name, onOpen, labels }: { membership: Membership; playhead: number; name: string; onOpen(): void; labels: { role: string; span: string; remove: string } }) {
  return (
    <li className={rowClass(m, playhead)}>
      <button className="link" onClick={onOpen}>
        {name}
      </button>
      <TextField label={labels.role} value={m.role} placeholder="Role" onCommit={(role) => void execute({ type: 'membership.update', payload: { id: m.id, patch: { role } } })} />
      <SpanFields span={m} label={labels.span} onCommit={(patch) => void execute({ type: 'membership.update', payload: { id: m.id, patch } })} />
      <button className="link" aria-label={labels.remove} onClick={() => void execute({ type: 'membership.delete', payload: { id: m.id } })}>
        ✕
      </button>
    </li>
  )
}

/** A world's characters and factions by id, for names. */
function usePartyNames(worldId: string) {
  const characters = useOwnRecords('characters', worldId)
  const factions = useOwnRecords('factions', worldId)
  return useMemo(() => {
    const names = new Map<string, string>([...characters.map((c) => [c.id, c.name] as const), ...factions.map((f) => [f.id, `${f.emblem ? `${f.emblem} ` : ''}${f.name}`] as const)])
    return { characters, factions, name: (p: Party) => names.get(p.id) ?? '?' }
  }, [characters, factions])
}

/** What the other side can be, from this side: "Parent" (they're the parent), "Child", "Ally"… */
const RELATION_CHOICES = RELATION_TYPES.flatMap((type) => {
  const info = RELATION_INFO[type]
  return info.from === info.to ? [{ key: type, label: info.from, type, otherFirst: false }] : [
    { key: `${type}:from`, label: info.from, type, otherFirst: true },
    { key: `${type}:to`, label: info.to, type, otherFirst: false }
  ]
})

/** Everyone `self` is related to: who, as what, and when; and a row to add another. */
export function RelationshipList({ worldId, self, label }: { worldId: string; self: Party; label: string }) {
  const all = useOwnRecords('relationships', worldId)
  const rels = useMemo(() => all.filter((r) => involves(r, self)), [all, self])
  const { characters, factions, name } = usePartyNames(worldId)
  const playhead = usePlayhead(worldId)
  const others: Party[] = [...characters.map((c) => ({ kind: 'character' as const, id: c.id })), ...factions.map((f) => ({ kind: 'faction' as const, id: f.id }))].filter((p) => !sameParty(p, self))
  const [with_, setWith] = useState('')
  const [as, setAs] = useState('ally')

  const add = () => {
    const other = others.find((p) => p.id === with_)
    const choice = RELATION_CHOICES.find((c) => c.key === as)
    if (!other || !choice) return
    const [from, to] = choice.otherFirst ? [other, self] : [self, other]
    void execute({ type: 'relationship.create', payload: { ownerId: worldId, from, to, type: choice.type } })
    setWith('')
  }

  return (
    <div className="field">
      <span>{label}</span>
      {rels.length > 0 && (
        <ul className="plain-list faction-rows" aria-label={label}>
          {rels.map((r) => {
            const other = otherParty(r, self)
            return (
              <li key={r.id} className={rowClass(r, playhead)} data-menu={menuRef('relationship', r.id)}>
                <button className="link" onClick={() => openElement(other)}>
                  {name(other)}
                </button>
                <span className="faction-role">{relationLabel(r, self)}</span>
                <SpanFields span={r} label={`${name(other)}, ${relationLabel(r, self)},`} onCommit={(patch) => void execute({ type: 'relationship.update', payload: { id: r.id, patch } })} />
                <button className="link" aria-label={`Remove ${name(other)} as ${relationLabel(r, self)}`} onClick={() => void execute({ type: 'relationship.delete', payload: { id: r.id } })}>
                  ✕
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {others.length > 0 && (
        <div className="field-row faction-add">
          <select aria-label="Relate to" value={with_} onChange={(e) => setWith(e.target.value)}>
            <option value="">Relate to…</option>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {name(p)}
              </option>
            ))}
          </select>
          <select aria-label="As" value={as} onChange={(e) => setAs(e.target.value)}>
            {RELATION_CHOICES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <button onClick={add} disabled={!with_}>
            Add
          </button>
        </div>
      )}
    </div>
  )
}

/** A character's factions: which, as what, and when; and a row to join another. */
export function MembershipList({ worldId, characterId }: { worldId: string; characterId: string }) {
  const all = useOwnRecords('memberships', worldId)
  const memberships = useMemo(() => all.filter((m) => m.characterId === characterId), [all, characterId])
  const factions = useOwnRecords('factions', worldId)
  const playhead = usePlayhead(worldId)
  const [joining, setJoining] = useState('')
  const name = (id: string) => factions.find((f) => f.id === id)?.name ?? '?'
  return (
    <div className="field">
      <span>Factions</span>
      {memberships.length > 0 && (
        <ul className="plain-list faction-rows" aria-label="Factions">
          {memberships.map((m) => (
            <MembershipRow
              key={m.id}
              membership={m}
              playhead={playhead}
              name={name(m.factionId)}
              onOpen={() => showFaction(m.factionId)}
              labels={{ role: `Role in ${name(m.factionId)}`, span: `In ${name(m.factionId)}`, remove: `Leave ${name(m.factionId)}` }}
            />
          ))}
        </ul>
      )}
      {factions.length > 0 ? (
        <select
          aria-label="Join a faction"
          value={joining}
          onChange={(e) => {
            setJoining('')
            if (e.target.value) void execute({ type: 'membership.create', payload: { factionId: e.target.value, characterId, start: playhead } })
          }}
        >
          <option value="">Join a faction…</option>
          {factions.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      ) : (
        <p className="muted small">This world has no factions yet: add them on its Factions page.</p>
      )}
    </div>
  )
}


/** Who took part in an event: chips for each character and faction, and a choice to add another. */
export function Participants({ worldId, participants, onCommit }: { worldId: string; participants: Party[]; onCommit(participants: Party[]): void }) {
  const { characters, factions, name } = usePartyNames(worldId)
  const add = (id: string) => {
    const kind = factions.some((f) => f.id === id) ? 'faction' : 'character'
    onCommit([...participants, { kind, id }])
  }
  const choices = [...factions.map((f) => ({ kind: 'faction' as const, id: f.id })), ...characters.map((c) => ({ kind: 'character' as const, id: c.id }))].filter(
    (p) => !participants.some((q) => sameParty(p, q))
  )
  return (
    <div className="field">
      <span>Who took part</span>
      {participants.length > 0 && (
        <ul className="chip-list" aria-label="Who took part">
          {participants.map((p) => (
            <li key={`${p.kind}:${p.id}`}>
              <button className="link" onClick={() => openElement(p)}>
                {name(p)}
              </button>
              <button className="link" aria-label={`${name(p)} didn’t take part`} onClick={() => onCommit(participants.filter((q) => !sameParty(p, q)))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {choices.length > 0 ? (
        <select aria-label="Add who took part" value="" onChange={(e) => e.target.value && add(e.target.value)}>
          <option value="">+ Who took part…</option>
          {choices.map((p) => (
            <option key={p.id} value={p.id}>
              {name(p)}
            </option>
          ))}
        </select>
      ) : (
        participants.length === 0 && <p className="muted small">Add characters or factions to the world to say who took part.</p>
      )}
    </div>
  )
}

/** Shows or hides a character's or faction's own lane on the timeline. */
export function LaneToggle({ worldId, id }: { worldId: string; id: string }) {
  const shown = useTimelineView((s) => s.lives[worldId]?.includes(id) ?? false)
  return (
    <label className="checkbox">
      <input type="checkbox" checked={shown} onChange={() => useTimelineView.getState().toggleLife(worldId, id)} /> A lane of its own on the timeline
    </label>
  )
}
