import type { BlueprintPart } from '@universe/core'
import { describe, expect, it } from 'vitest'
import { standingParts } from './structureLook'

const part = (material: BlueprintPart['material'], y: number, h = 10): BlueprintPart => ({ shape: 'box', material, color: '#fff', size: [10, h, 10], at: [0, y, 0], rotation: 0 })

describe('standingParts', () => {
  it('drops fragile parts first as condition falls', () => {
    const walls = part('stone', 0)
    const roof = part('wood', 10, 3)
    expect(standingParts([walls, roof], 80)).toEqual([walls, roof])
    expect(standingParts([walls, roof], 30)).toEqual([walls])
  })

  it('leaves nothing floating once what holds it up is gone', () => {
    const base = part('mud', 0)
    const shrine = part('brick', 10)
    expect(standingParts([base, part('mud', 0), shrine], 10)).not.toContain(shrine)
  })

  it('with each material’s own condition, drops that material’s parts from the top down', () => {
    const walls = part('stone', 0)
    const lower = part('wood', 10, 3)
    const upper = part('wood', 13, 3)
    expect(standingParts([walls, lower, upper], 80, { stone: 95, wood: 60 })).toEqual([walls, lower, upper])
    expect(standingParts([walls, lower, upper], 70, { stone: 95, wood: 30 })).toEqual([walls, lower])
    expect(standingParts([walls, lower, upper], 60, { stone: 95, wood: 5 })).toEqual([walls])
  })
})
