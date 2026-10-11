import { CardUrl, type CardTarget } from '@universe/core'
import { useMemo, useState } from 'react'
import { Modal } from '../../components/Modal'
import { useUi } from '../../store'
import { TARGET_LABELS } from './elements'

/** Asks for a web page's address for a link card. */
export function LinkDialog({ onAdd, onClose }: { onAdd(url: string): void; onClose(): void }) {
  const [url, setUrl] = useState('https://')
  const valid = CardUrl.safeParse(url.trim()).success
  return (
    <Modal title="Add a web page" closeLabel="Close web page" className="canvas-dialog" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onAdd(url.trim())
        }}
      >
        <label className="field">
          <span>Address</span>
          <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </label>
        <p className="muted small">It opens in your browser: Universe itself stays offline.</p>
        <button className="primary" disabled={!valid}>
          Add
        </button>
      </form>
    </Modal>
  )
}

interface Choice {
  target: CardTarget
  name: string
  kind: string
}

/** Picks something of the project for an element card: a place, a region, an event, a character… on this world, found by name. */
export function ElementPicker({ worldId, onPick, onClose }: { worldId: string; onPick(target: CardTarget): void; onClose(): void }) {
  const nodes = useUi((s) => s.nodes)
  const regions = useUi((s) => s.regions)
  const t = useUi((s) => s.timeline)
  const [query, setQuery] = useState('')
  const choices = useMemo(() => {
    const own = <R extends { ownerId: string }>(list: R[]) => list.filter((r) => r.ownerId === worldId)
    const of = <R extends { id: string }>(kind: Exclude<CardTarget['kind'], 'waterway'>, list: R[], name: (r: R) => string): Choice[] =>
      list.map((r) => ({ target: { kind, id: r.id }, name: name(r), kind: TARGET_LABELS[kind] }))
    return [
      ...of('node', nodes, (n) => n.name),
      ...of('region', regions.filter((r) => r.worldId === worldId), (r) => r.name),
      ...of('event', own(t.events), (e) => e.title),
      ...of('era', own(t.eras), (e) => e.name),
      ...of('character', own(t.characters), (c) => c.name),
      ...of('faction', own(t.factions), (f) => f.name),
      ...of('structure', own(t.structures), (s) => s.name),
      ...of('species', own(t.lifeforms), (s) => s.name),
      // Rivers and lakes given a name of their own (the rest are the terrain's, named as it changes).
      ...own(t.waterways).filter((w) => w.name).map((w): Choice => ({ target: { kind: 'waterway', id: w.key }, name: w.name, kind: TARGET_LABELS.waterway })),
      ...of('power', t.powers, (p) => p.name),
      ...of('theme', t.themes, (x) => x.name)
    ]
  }, [nodes, regions, t, worldId])
  const words = query.trim().toLowerCase()
  const shown = (words ? choices.filter((c) => c.name.toLowerCase().includes(words)) : choices).slice(0, 200)
  return (
    <Modal title="Add an element" closeLabel="Close elements" className="canvas-dialog" onClose={onClose}>
      <input autoFocus aria-label="Find an element" placeholder="Find by name…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="link-list canvas-element-choices">
        {shown.map((c) => (
          <li key={`${c.target.kind}:${c.target.id}`}>
            <button className="link" onClick={() => onPick(c.target)}>
              {c.name}
            </button>{' '}
            <span className="muted small">{c.kind}</span>
          </li>
        ))}
        {!shown.length && <li className="muted small">Nothing by that name.</li>}
      </ul>
    </Modal>
  )
}
