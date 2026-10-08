import { EMPTY_TIMELINE, type SpatialNode } from '@universe/core'
import { describe, expect, it } from 'vitest'
import type { AppState } from '../../shared/api'
import { reconcile } from './reconcile'

const node = (id: string, updatedAt = 't1'): SpatialNode => ({
  id, parentId: null, kind: 'universe', name: id, seed: 1, position: { x: 0, y: 0, z: 0 }, notes: '', tags: [], createdAt: 't0', updatedAt, deletedAt: null
})
const state = (nodes: SpatialNode[]): AppState => ({
  project: { path: '/p', name: 'P', rootId: 'a' }, nodes, worlds: [], regions: [], timeline: EMPTY_TIMELINE, canUndo: true, canRedo: false, aiChanges: 0, proposals: []
})
// What main sends: a structured copy of everything.
const copy = (s: AppState): AppState => structuredClone(s)

describe('reconcile', () => {
  it('keeps every object a command left alone, and the arrays holding only those', () => {
    const before = state([node('a'), node('b')])
    const after = reconcile(before, copy(before))
    expect(after.nodes).toBe(before.nodes)
    expect(after.timeline).toBe(before.timeline)
    expect(after.project).toBe(before.project)
  })

  it('takes what changed, keeping the rest', () => {
    const before = state([node('a'), node('b')])
    const next = copy(before)
    next.nodes[1] = node('b', 't2')
    next.nodes.push(node('c'))
    const after = reconcile(before, next)
    expect(after.nodes).not.toBe(before.nodes)
    expect(after.nodes[0]).toBe(before.nodes[0])
    expect(after.nodes[1]).toBe(next.nodes[1])
    expect(after.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(reconcile(before, state([node('a')])).nodes).toHaveLength(1)
  })
})
