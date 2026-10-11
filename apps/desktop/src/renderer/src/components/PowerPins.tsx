import type { PowerSystem, SpatialNode } from '@universe/core'
import { useMemo } from 'react'
import { KIND_ICONS } from '../kinds'
import { byId, useUi, usePowersOn } from '../store'
import { execute } from './FactionParts'
import { Swatch } from './fields'

/**
 * Where power systems hold (PLAN.md §4.6). Systems are the universe's,
 * shared by every place they're pinned to: a node (a planet, a star system,
 * a galaxy, the universe) and everything in it, or an era on a timeline.
 */

/** Pins a system to a node too. */
export const pinPower = (system: PowerSystem, nodeId: string) => execute({ type: 'power.update', payload: { id: system.id, patch: { pins: [...system.pins, nodeId] } } })
const pin = (system: PowerSystem, nodeId: string) => void pinPower(system, nodeId)
const unpin = (system: PowerSystem, nodeId: string) => void execute({ type: 'power.update', payload: { id: system.id, patch: { pins: system.pins.filter((id) => id !== nodeId) } } })

/** Every node, the universe first and each one's insides after it, indented. */
function useNodeTree(): { node: SpatialNode; depth: number }[] {
  const nodes = useUi((s) => s.nodes)
  return useMemo(() => {
    const children = new Map<string | null, SpatialNode[]>()
    for (const n of nodes) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n])
    const out: { node: SpatialNode; depth: number }[] = []
    const visit = (parentId: string | null, depth: number) => {
      for (const node of children.get(parentId) ?? []) {
        out.push({ node, depth })
        visit(node.id, depth + 1)
      }
    }
    visit(null, 0)
    return out
  }, [nodes])
}

const nodeLabel = (n: SpatialNode, depth = 0) => `${'  '.repeat(depth)}${KIND_ICONS[n.kind]} ${n.name}`

/** A system's pins: each place it holds on (with all that's in it), to unpin, and a choice of anywhere else to pin it. */
export function PinsField({ system }: { system: PowerSystem }) {
  const tree = useNodeTree()
  const nodes = byId(useUi((s) => s.nodes))
  const pinned = system.pins.flatMap((id) => nodes.get(id) ?? [])
  return (
    <div className="field">
      <span>Holds on</span>
      {pinned.length > 0 ? (
        <ul className="chip-list" aria-label="Pinned to">
          {pinned.map((n) => (
            <li key={n.id}>
              {nodeLabel(n)}
              <button className="link" aria-label={`Unpin from ${n.name}`} onClick={() => unpin(system, n.id)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Pinned nowhere: it holds only in the eras it describes. Pin it to a planet, a star system or anything else for it to hold there in every age.</p>
      )}
      <select aria-label="Pin to" value="" onChange={(e) => e.target.value && pin(system, e.target.value)}>
        <option value="">+ Pin to… (and everything in it)</option>
        {tree
          .filter(({ node }) => !system.pins.includes(node.id))
          .map(({ node, depth }) => (
            <option key={node.id} value={node.id}>
              {nodeLabel(node, depth)}
            </option>
          ))}
      </select>
    </div>
  )
}

/** The power systems that hold on a node, why (where each is pinned), and pinning one from the universe's library here. */
export function PowersHere({ node }: { node: SpatialNode }) {
  const here = usePowersOn(node.id)
  const all = useUi((s) => s.timeline.powers)
  const nodes = byId(useUi((s) => s.nodes))
  const others = all.filter((s) => !here.includes(s))
  if (!all.length) return null
  const where = (s: PowerSystem) => (s.pins.includes(node.id) ? 'pinned here' : s.pins.flatMap((id) => nodes.get(id)?.name ?? []).join(', ') || 'in an era here')
  return (
    <section className="inspector-section" aria-label="Power systems here">
      <div className="field">
        <span>Power systems here</span>
        {here.length > 0 ? (
          <ul className="plain-list">
            {here.map((s) => (
              <li key={s.id} className="power-here">
                <Swatch color={s.color} /> {s.name} <span className="muted small">· {where(s)}</span>
                {s.pins.includes(node.id) && (
                  <button className="link" aria-label={`Unpin ${s.name} from ${node.name}`} onClick={() => unpin(s, node.id)}>
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">None hold here yet.</p>
        )}
        {others.length > 0 && (
          <select aria-label="Pin a power system here" value="" onChange={(e) => e.target.value && pin(others.find((s) => s.id === e.target.value)!, node.id)}>
            <option value="">+ Pin a power system here…</option>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </section>
  )
}
