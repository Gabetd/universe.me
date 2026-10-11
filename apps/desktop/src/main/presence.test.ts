import { describe, expect, it } from 'vitest'
import { PRESENCE_MS, Presences } from './presence'

const MAP = { nodeId: 'terra', view: 'map', label: 'Terra, the map' }
const bob = (age: number, where: typeof MAP | null = MAP) => ({ login: 'bob@example.com', name: 'Bob', where, age })

describe('who’s in a universe', () => {
  it('keeps the newest word of each person, by how long ago it was heard, for half a minute', () => {
    const p = new Presences()
    p.hear('s1', [bob(1000)], 'me@example.com', 10_000)
    // Passed on later, an older word doesn't replace a newer one.
    p.hear('s1', [bob(5000, null)], 'me@example.com', 11_000)
    expect(p.in('s1', 'me@example.com', 11_000)).toEqual([{ login: 'bob@example.com', name: 'Bob', where: MAP }])
    // Passed on again, it's as old as it was, not new.
    expect(p.wire('s1', 'me@example.com', 12_000)).toEqual([bob(3000)])
    expect(p.in('s1', undefined, 9000 + PRESENCE_MS)).toEqual([])
    // Too old to keep, it isn't.
    p.hear('s1', [bob(PRESENCE_MS)], undefined, 50_000)
    expect(p.in('s1', undefined, 50_000)).toEqual([])
  })

  it('never keeps this computer’s own person, never gives anyone their own entry, and keeps each universe apart', () => {
    const p = new Presences()
    p.hear('s1', [bob(0), { login: 'me@example.com', name: 'Me', where: null, age: 0 }], 'me@example.com', 0)
    expect(p.in('s1', undefined, 0).map((x) => x.login)).toEqual(['bob@example.com'])
    expect(p.wire('s1', 'bob@example.com', 0)).toEqual([])
    expect(p.in('s2', undefined, 0)).toEqual([])
  })
})
