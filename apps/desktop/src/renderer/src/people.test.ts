import type { SpatialNode } from '@universe/core'
import { describe, expect, it } from 'vitest'
import type { PersonIn } from '../../shared/api'
import { initials, isWorldView, peopleByNode, personHue, personLine, whereOn } from './people'

const node = (id: string, kind: SpatialNode['kind'], name = id): SpatialNode => ({
  id, parentId: null, kind, name, seed: 1, position: { x: 0, y: 0, z: 0 }, notes: '', tags: [], createdAt: 't0', updatedAt: 't0', deletedAt: null
})
const person = (login: string, nodeId: string | null, label = ''): PersonIn => ({ login, name: login.split('@')[0]!, where: nodeId === null ? null : { nodeId, view: 'map', label } })

describe('people', () => {
  it('says where the user is: a world with its view, anything else by its name, the universe with nothing selected', () => {
    expect(whereOn(node('w', 'world', 'Terra'), 'map', 'Aerth')).toEqual({ nodeId: 'w', view: 'map', label: 'Terra, the map' })
    expect(whereOn(node('s', 'star_system', 'Sol'), 'map', 'Aerth')).toEqual({ nodeId: 's', view: 'space', label: 'Sol' })
    expect(whereOn(undefined, 'globe', 'Aerth')).toEqual({ nodeId: null, view: 'space', label: 'Aerth' })
  })

  it('keeps a label as short as main takes, the view still in it', () => {
    const where = whereOn(node('w', 'world', 'x'.repeat(200)), 'factions', 'Aerth')
    expect(where.label).toHaveLength(200)
    expect(where.label.endsWith(', its factions')).toBe(true)
  })

  it('knows a world’s views from the rest', () => {
    expect(isWorldView('canvas')).toBe(true)
    expect(isWorldView('space')).toBe(false)
    expect(isWorldView('toString')).toBe(false)
  })

  it('reads someone’s mark and where they are', () => {
    expect(initials('Ana Lima Souza')).toBe('AS')
    expect(initials('bea')).toBe('B')
    expect(initials('  ')).toBe('?')
    expect(personHue('ana@example.com')).toBe(personHue('ana@example.com'))
    expect(personHue('ana@example.com')).not.toBe(personHue('bea@example.com'))
    expect(personLine(person('ana@example.com', 'w', 'Terra, the map'))).toBe('ana, on Terra, the map')
    expect(personLine(person('ana@example.com', null))).toBe('ana, just in')
  })

  it('groups who’s in by the node they’re on', () => {
    const [ana, bea, cy] = [person('ana@x.com', 'w'), person('bea@x.com', 'w'), person('cy@x.com', null)]
    const byNode = peopleByNode([ana, bea, cy])
    expect(byNode.get('w')).toEqual([ana, bea])
    expect([...byNode.keys()]).toEqual(['w'])
  })
})
