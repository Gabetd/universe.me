import { describe, expect, it } from 'vitest'
import { MemoryStore, createRootUniverse, type Lane } from './index'

const lane = (id: string, ownerId: string, deletedAt: string | null = null): Lane => ({ id, ownerId, name: id, order: 0, createdAt: 't', updatedAt: 't', deletedAt })

// packages/db checks the same on SQLite (sqlite-store.test.ts).
describe('MemoryStore', () => {
  it('finds the root, and one owner’s live records in the order of all()', () => {
    const store = new MemoryStore()
    const root = createRootUniverse(store, 'U')
    store.nodes.insert({ ...root, id: 'cluster', parentId: root.id, kind: 'galaxy_cluster' })
    expect(store.nodes.root()?.id).toBe(root.id)

    for (const l of [lane('z', root.id), lane('a', 'cluster'), lane('m', root.id), lane('gone', root.id, 't'), lane('b', root.id)]) store.records('lane').insert(l)
    expect(store.records('lane').byOwner(root.id).map((l) => l.id)).toEqual(['z', 'm', 'b'])
    expect(store.records('lane').byOwner('cluster').map((l) => l.id)).toEqual(['a'])
    expect(store.records('lane').byOwner('nobody')).toEqual([])
    expect(store.records('era').byOwner(root.id)).toEqual([])
  })
})
