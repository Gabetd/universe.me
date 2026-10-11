import { describe, expect, it } from 'vitest'
import { changedFields, fieldsOf, rowOf, sameValue, valueAt } from './fields'

describe('a row as fields', () => {
  it('goes down into plain objects only, and comes back the same', () => {
    const row = { name: 'Virgo', terrain: { water: 0.6, colors: ['#fff'] }, canvas: null, empty: {}, 'a/b~c': 1 }
    const fields = fieldsOf(row)
    expect([...fields.keys()]).toEqual(['/name', '/terrain/water', '/terrain/colors', '/canvas', '/empty', '/a~1b~0c'])
    expect(rowOf(fields)).toEqual(row)
    expect(valueAt(row, '/a~1b~0c')).toBe(1)
    expect(valueAt(row, '/terrain/water/deeper')).toBeUndefined()
  })

  it('lets a later field replace what’s in its way', () => {
    expect(rowOf([['/canvas', null], ['/canvas/x', 1]])).toEqual({ canvas: { x: 1 } })
    expect(rowOf([['/canvas/x', 1], ['/canvas', null]])).toEqual({ canvas: null })
  })

  it('finds what changed, however keys are ordered', () => {
    expect(sameValue({ a: 1, b: [{ c: 2, d: 3 }] }, { b: [{ d: 3, c: 2 }], a: 1 })).toBe(true)
    expect(sameValue([1, 2], [2, 1])).toBe(false)
    expect(changedFields(fieldsOf({ a: 1, canvas: { x: 1, y: 2 } }), fieldsOf({ canvas: null, a: 1 })).sort()).toEqual(['/canvas', '/canvas/x', '/canvas/y'])
  })
})
