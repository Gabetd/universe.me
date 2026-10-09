import { describe, expect, it } from 'vitest'
import { fromWire, toWire } from './wire'

describe('the bridge’s JSON', () => {
  it('carries byte arrays and gaps in arrays as they are', () => {
    const value = { worldId: 'w', revision: 3, height: [new Uint8Array([1, 2, 255]), undefined, new Uint8Array(0)], ok: true, nothing: null }
    const back = fromWire<typeof value>(toWire(value))
    expect(back).toEqual(value)
    expect(back.height[0]).toBeInstanceOf(Uint8Array)
    expect(1 in back.height).toBe(true)
    expect(back.height[1]).toBeUndefined()
  })

  it('leaves plain objects that look a little like them alone', () => {
    const value = { $bytes: 5, other: { $gap: 1, more: 2 } }
    expect(fromWire(toWire(value))).toEqual(value)
  })
})
