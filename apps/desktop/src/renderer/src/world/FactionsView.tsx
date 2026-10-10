import {
  FACTION_KINDS,
  FACTION_KIND_LABELS,
  RELATION_INFO,
  formatTime,
  holdsAt,
  relationshipsAt,
  wouldLoop,
  type Faction,
  type FactionKind,
  type FactionPatch,
  type Party
} from '@universe/core'
import { useMemo, useRef, useState } from 'react'
import { LaneToggle, RelationshipList, SpanFields } from '../components/FactionParts'
import { ColorField, DeleteButton, NotesField, SelectField, Swatch, TagsField, TextField } from '../components/fields'
import { menuRef, openElement, openElementMenu } from '../contextMenu'
import { flagClass, useFlaggedIds } from '../flags'
import { useOwnRecords, useUi } from '../store'
import { usePlayhead } from '../timeline/timelineStore'
import { useSteadyScroll } from '../useSteadyScroll'
import { useEditor } from './editorStore'
import { useCalendar } from './useSky'

/**
 * A world's factions and relationships (PLAN.md §9, M14): its kingdoms,
 * houses, guilds and faiths, part of one another, on the left; one faction
 * on the right, with when it stood, who's in it, what it holds and how it
 * stands with others. Or the graph of who's related to whom at the playhead.
 */

const execute = (command: Parameters<ReturnType<typeof useUi.getState>['execute']>[0]) => useUi.getState().execute(command)

type Tab = 'factions' | 'graph'

export function FactionsView({ worldId }: { worldId: string }) {
  const factions = useOwnRecords('factions', worldId)
  const selectedId = useEditor((s) => s.factionId)
  const selected = factions.find((f) => f.id === selectedId) ?? factions[0]
  const [tab, setTab] = useState<Tab>('factions')
  const playhead = usePlayhead(worldId)

  const pick = (id: string) => {
    useEditor.getState().set({ factionId: id })
    setTab('factions')
  }
  const add = async (kind: FactionKind) => {
    const state = await execute({ type: 'faction.create', payload: { ownerId: worldId, kind, name: `New ${FACTION_KIND_LABELS[kind].toLowerCase()}` } })
    if (state?.focus?.id) useEditor.getState().set({ factionId: state.focus.id })
    setTab('factions')
  }

  return (
    <div className="powers-view factions-view">
      <aside className="eco-side">
        <div className="segmented" role="tablist" aria-label="Factions page">
          <button role="tab" aria-selected={tab === 'factions'} onClick={() => setTab('factions')}>
            ⚑ Factions
          </button>
          <button role="tab" aria-selected={tab === 'graph'} onClick={() => setTab('graph')}>
            ⚭ Who’s related
          </button>
        </div>
        <select aria-label="New faction" value="" onChange={(e) => e.target.value && void add(e.target.value as FactionKind)}>
          <option value="">+ Faction…</option>
          {FACTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {FACTION_KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <FactionTree factions={factions} selectedId={tab === 'factions' ? selected?.id : undefined} playhead={playhead} onPick={pick} />
      </aside>
      {tab === 'graph' ? (
        <RelationshipGraph worldId={worldId} />
      ) : selected ? (
        <FactionEditor key={selected.id} worldId={worldId} faction={selected} factions={factions} />
      ) : (
        <section className="powers-start" aria-label="Start a faction">
          <h3>Who holds power on this world?</h3>
          <p className="muted">
            Factions are its kingdoms, houses, clans, guilds, orders and faiths: each founded and perhaps dissolved, with members who come and go and land it holds and loses. Pick a kind to start one.
          </p>
          <div className="powers-templates">
            {FACTION_KINDS.map((k) => (
              <button key={k} onClick={() => void add(k)}>
                <b>{FACTION_KIND_LABELS[k]}</b>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** Factions under the ones they're part of; dimmed while they don't exist at the playhead. */
function FactionTree({ factions, selectedId, playhead, onPick }: { factions: Faction[]; selectedId: string | undefined; playhead: number; onPick(id: string): void }) {
  const flagged = useFlaggedIds()
  const rows = useMemo(() => {
    const ids = new Set(factions.map((f) => f.id))
    const out: { faction: Faction; depth: number }[] = []
    const walk = (parentId: string | null, depth: number) => {
      for (const f of factions) {
        // A faction whose parent is gone shows at the top.
        const parent = f.parentId && ids.has(f.parentId) ? f.parentId : null
        if (parent === parentId && depth < 20) {
          out.push({ faction: f, depth })
          walk(f.id, depth + 1)
        }
      }
    }
    walk(null, 0)
    return out
  }, [factions])
  const menu = (e: React.MouseEvent, id: string) => {
    e.preventDefault()
    openElementMenu({ kind: 'faction', id }, e.clientX, e.clientY, { open: () => onPick(id) })
  }
  return (
    <ul className="region-list" aria-label="The world’s factions">
      {rows.map(({ faction: f, depth }) => {
        const exists = holdsAt(f, playhead)
        return (
          <li key={f.id} style={{ paddingLeft: depth * 14 }}>
            <button
              className={`link region-row${f.id === selectedId ? ' selected' : ''}${exists ? '' : ' absent'}${flagClass(flagged.has(f.id))}`}
              title={exists ? undefined : 'Not there at the playhead'}
              onClick={() => onPick(f.id)}
              onContextMenu={(e) => menu(e, f.id)}
            >
              <Swatch color={f.color} />
              {f.emblem && <span aria-hidden>{f.emblem}</span>} {f.name} <span className="muted small">· {FACTION_KIND_LABELS[f.kind]}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function FactionEditor({ worldId, faction, factions }: { worldId: string; faction: Faction; factions: Faction[] }) {
  const update = (patch: FactionPatch) => void execute({ type: 'faction.update', payload: { id: faction.id, patch } })
  const events = useOwnRecords('events', worldId)
  const cal = useCalendar(worldId)
  const playhead = usePlayhead(worldId)
  const content = useRef<HTMLElement>(null)
  useSteadyScroll(content, faction.id)
  // What it can be part of: not itself, nor one of its own parts.
  const parents = factions.filter((f) => f.id !== faction.id && !wouldLoop(factions, faction.id, f.id))
  const exists = holdsAt(faction, playhead)
  const eventOptions = useMemo(
    () =>
      [...events]
        .sort((a, b) => a.start - b.start)
        .map((e) => (
          <option key={e.id} value={e.id}>
            {formatTime(e.start, e.precision, cal)} · {e.title}
          </option>
        )),
    [events, cal]
  )
  /** An event as the cause of its founding or end: the date follows it. */
  const cause = (which: 'start' | 'end', eventId: string) => {
    const e = events.find((x) => x.id === eventId)
    update(which === 'start' ? { startEventId: e?.id ?? null, ...(e && { start: e.start }) } : { endEventId: e?.id ?? null, ...(e && { end: e.end ?? e.start }) })
  }

  return (
    <div className="powers-scroll">
      <section className="powers-editor" aria-label="Faction" ref={content}>
        <div className="powers-head">
          <TextField label="Faction name" value={faction.name} required onCommit={(name) => update({ name })} />
          <SelectField label="Kind" value={faction.kind} options={FACTION_KIND_LABELS} onCommit={(kind) => update({ kind })} />
          <ColorField label="Faction color" value={faction.color} onCommit={(color) => update({ color })} />
        </div>
        <div className="field-pair">
          <TextField label="Emblem" value={faction.emblem} placeholder="An emoji or a letter" onCommit={(emblem) => update({ emblem: [...emblem].slice(0, 4).join('') })} />
          <label className="field">
            <span>Part of</span>
            <select aria-label="Part of" value={faction.parentId ?? ''} onChange={(e) => update({ parentId: e.target.value || null })}>
              <option value="">Nothing: it answers to no one</option>
              {parents.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <TextField label="What it is" value={faction.summary} placeholder="In a line: who they are and what they want" onCommit={(summary) => update({ summary })} />
        <div className="field">
          <span>When</span>
          <SpanFields span={faction} label="Faction" from="Founded" until="Dissolved" onCommit={update} />
          <div className="field-row">
            <select aria-label="Founded by" value={faction.startEventId ?? ''} onChange={(e) => cause('start', e.target.value)}>
              <option value="">Founded by an event…</option>
              {eventOptions}
            </select>
            <select aria-label="Ended by" value={faction.endEventId ?? ''} onChange={(e) => cause('end', e.target.value)}>
              <option value="">Ended by an event…</option>
              {eventOptions}
            </select>
          </div>
          <p className="muted small" data-testid="faction-status">
            {exists ? `There at ${formatTime(playhead, 'year', cal)}.` : faction.start !== null && playhead < faction.start ? `Not founded yet at ${formatTime(playhead, 'year', cal)}.` : `Gone by ${formatTime(playhead, 'year', cal)}.`}
          </p>
        </div>
        <LaneToggle worldId={worldId} id={faction.id} />
        <MemberRows worldId={worldId} factionId={faction.id} />
        <TerritoryRows worldId={worldId} factionId={faction.id} />
        <RelationshipList worldId={worldId} self={{ kind: 'faction', id: faction.id }} label="Stands with" />
        <TagsField label="Faction tags" tags={faction.tags} onCommit={(tags) => update({ tags })} />
        <NotesField label="Faction notes" value={faction.notes} onCommit={(notes) => update({ notes })} />
        <DeleteButton kind="faction" ids={[faction.id]}>
          Delete faction
        </DeleteButton>
      </section>
    </div>
  )
}

/** A faction's members, as what and when; and a row to add one (from the playhead). */
function MemberRows({ worldId, factionId }: { worldId: string; factionId: string }) {
  const all = useOwnRecords('memberships', worldId)
  const memberships = useMemo(() => all.filter((m) => m.factionId === factionId), [all, factionId])
  const characters = useOwnRecords('characters', worldId)
  const playhead = usePlayhead(worldId)
  const name = (id: string) => characters.find((c) => c.id === id)?.name ?? '(deleted)'
  return (
    <div className="field">
      <span>Members</span>
      {memberships.length > 0 && (
        <ul className="plain-list faction-rows" aria-label="Members">
          {memberships.map((m) => (
            <li key={m.id} className={`faction-row${holdsAt(m, playhead) ? '' : ' absent'}`}>
              <button className="link" onClick={() => useUi.getState().selectCharacter(m.characterId)}>
                {name(m.characterId)}
              </button>
              <TextField label={`${name(m.characterId)}’s role`} value={m.role} placeholder="Role" onCommit={(role) => void execute({ type: 'membership.update', payload: { id: m.id, patch: { role } } })} />
              <SpanFields span={m} label={`${name(m.characterId)} a member`} onCommit={(patch) => void execute({ type: 'membership.update', payload: { id: m.id, patch } })} />
              <button className="link" aria-label={`Remove ${name(m.characterId)}`} onClick={() => void execute({ type: 'membership.delete', payload: { id: m.id } })}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {characters.length > 0 ? (
        <select aria-label="Add a member" value="" onChange={(e) => e.target.value && void execute({ type: 'membership.create', payload: { factionId, characterId: e.target.value, start: playhead } })}>
          <option value="">Add a member from the playhead…</option>
          {characters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      ) : (
        <p className="muted small">Add characters to the world (in its inspector) to make them members.</p>
      )}
    </div>
  )
}

/** The regions a faction holds, and when; and a row to give it another. */
function TerritoryRows({ worldId, factionId }: { worldId: string; factionId: string }) {
  const all = useOwnRecords('holdings', worldId)
  const holdings = useMemo(() => all.filter((h) => h.factionId === factionId), [all, factionId])
  const allRegions = useUi((s) => s.regions)
  const regions = useMemo(() => allRegions.filter((r) => r.worldId === worldId), [allRegions, worldId])
  const playhead = usePlayhead(worldId)
  const name = (id: string) => regions.find((r) => r.id === id)?.name ?? '(a deleted region)'
  return (
    <div className="field">
      <span>Territory</span>
      {holdings.length > 0 && (
        <ul className="plain-list faction-rows" aria-label="Territory">
          {holdings.map((h) => (
            <li key={h.id} className={`faction-row${holdsAt(h, playhead) ? '' : ' absent'}`}>
              <button className="link" onClick={() => useUi.getState().selectRegion(h.regionId)}>
                {name(h.regionId)}
              </button>
              <SpanFields span={h} label={`Holds ${name(h.regionId)}`} onCommit={(patch) => void execute({ type: 'holding.update', payload: { id: h.id, patch } })} />
              <button className="link" aria-label={`Give up ${name(h.regionId)}`} onClick={() => void execute({ type: 'holding.delete', payload: { id: h.id } })}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {regions.length > 0 ? (
        <select
          aria-label="Hold a region"
          value=""
          onChange={(e) => e.target.value && void execute({ type: 'holding.create', payload: { factionId, regionId: e.target.value, start: playhead } })}
        >
          <option value="">Hold a region from the playhead…</option>
          {regions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      ) : (
        <p className="muted small">Draw regions on the globe or the map (⬠) to give a faction land.</p>
      )}
    </div>
  )
}

const TONE_COLORS: Record<(typeof RELATION_INFO)[keyof typeof RELATION_INFO]['tone'], string> = {
  kin: '#e8b04a',
  good: '#6fae7e',
  bad: '#e06c6c',
  bond: '#7aa2ff',
  other: '#9aa7c7'
}

/** A line's label: its own name, or the type ("Allies"; "Parent → Child" for one that reads differently each way). */
function edgeLabel(r: { type: keyof typeof RELATION_INFO; label: string }): string {
  const { from, to } = RELATION_INFO[r.type]
  return r.label || (from === to ? from : `${from} → ${to}`)
}

/** Who's related to whom at the playhead: characters and factions round a circle, a line for each relationship (dashed for who's in what). */
function RelationshipGraph({ worldId }: { worldId: string }) {
  const relationships = useOwnRecords('relationships', worldId)
  const memberships = useOwnRecords('memberships', worldId)
  const characters = useOwnRecords('characters', worldId)
  const factions = useOwnRecords('factions', worldId)
  const playhead = usePlayhead(worldId)
  const cal = useCalendar(worldId)

  const { nodes, edges, members } = useMemo(() => {
    const rels = relationshipsAt(relationships, playhead)
    const inFaction = memberships.filter((m) => holdsAt(m, playhead) && factions.some((f) => f.id === m.factionId && holdsAt(f, playhead)))
    const key = (p: Party) => `${p.kind}:${p.id}`
    const shown = new Map<string, { party: Party; name: string; color: string; emblem?: string }>()
    const show = (p: Party) => {
      if (shown.has(key(p))) return
      const record = p.kind === 'faction' ? factions.find((f) => f.id === p.id) : characters.find((c) => c.id === p.id)
      if (record) shown.set(key(p), { party: p, name: record.name, color: record.color, emblem: 'emblem' in record ? record.emblem : undefined })
    }
    for (const r of rels) {
      show(r.from)
      show(r.to)
    }
    for (const m of inFaction) {
      show({ kind: 'faction', id: m.factionId })
      show({ kind: 'character', id: m.characterId })
    }
    // Factions first, then people, so each kind sits together round the circle.
    const list = [...shown.values()].sort((a, b) => (a.party.kind === b.party.kind ? a.name.localeCompare(b.name) : a.party.kind === 'faction' ? -1 : 1))
    const at = new Map(list.map((n, i) => [key(n.party), (i / list.length) * 2 * Math.PI - Math.PI / 2]))
    const point = (p: Party) => {
      const a = at.get(key(p)) ?? 0
      return { x: 300 + 210 * Math.cos(a), y: 230 + 180 * Math.sin(a) }
    }
    return {
      nodes: list.map((n) => ({ ...n, ...point(n.party) })),
      edges: rels.filter((r) => shown.has(key(r.from)) && shown.has(key(r.to))).map((r) => ({ id: r.id, a: point(r.from), b: point(r.to), color: TONE_COLORS[RELATION_INFO[r.type].tone], label: edgeLabel(r) })),
      members: inFaction.filter((m) => shown.has(`faction:${m.factionId}`) && shown.has(`character:${m.characterId}`)).map((m) => ({ id: m.id, a: point({ kind: 'faction', id: m.factionId }), b: point({ kind: 'character', id: m.characterId }) }))
    }
  }, [relationships, memberships, characters, factions, playhead])

  return (
    <section className="relationship-graph" aria-label="Who’s related to whom">
      <p className="muted small">
        As of {formatTime(playhead, 'year', cal)}: move the playhead to see it change. Lines are relationships (gold kin, green friends and allies, red enemies, blue lieges and mentors); dashes are who’s in which faction.
      </p>
      {nodes.length === 0 ? (
        <p className="muted">No one is related to anyone at the playhead. Relate people and factions in their panels (Stands with, Relationships).</p>
      ) : (
        <svg viewBox="0 0 600 460" role="img" aria-label="Relationship graph" data-testid="relationship-graph">
          {members.map((m) => (
            <line key={m.id} x1={m.a.x} y1={m.a.y} x2={m.b.x} y2={m.b.y} className="graph-member" />
          ))}
          {edges.map((e) => (
            <g key={e.id} data-menu={menuRef('relationship', e.id)}>
              <line x1={e.a.x} y1={e.a.y} x2={e.b.x} y2={e.b.y} stroke={e.color} strokeWidth={2.5} />
              <text x={(e.a.x + e.b.x) / 2} y={(e.a.y + e.b.y) / 2 - 4} className="graph-edge-label" fill={e.color}>
                {e.label}
              </text>
            </g>
          ))}
          {nodes.map((n) => (
            <g key={`${n.party.kind}:${n.party.id}`} className="graph-node" data-menu={menuRef(n.party.kind, n.party.id)} onClick={() => openElement(n.party)} tabIndex={0} role="button" aria-label={n.name}>
              {/* The shape and its name are one target. */}
              <rect x={n.x - 50} y={n.y - 16} width={100} height={52} fill="transparent" />
              {n.party.kind === 'faction' ? <rect x={n.x - 14} y={n.y - 14} width={28} height={28} rx={6} fill={n.color} /> : <circle cx={n.x} cy={n.y} r={11} fill={n.color} />}
              {n.emblem && (
                <text x={n.x} y={n.y + 5} textAnchor="middle" className="graph-emblem">
                  {n.emblem}
                </text>
              )}
              <text x={n.x} y={n.y + 30} textAnchor="middle" className="graph-name">
                {n.name}
              </text>
            </g>
          ))}
        </svg>
      )}
    </section>
  )
}
