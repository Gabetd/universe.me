import type { TimelineEvent } from '@universe/core'
import { describe, expect, it } from 'vitest'
import { boxEdge, nodeDepth, project } from './canvasDepth'

const event = (start: number, end: number | null = null) => ({ start, end }) as TimelineEvent

describe('nodeDepth', () => {
  it('keeps future and current events at the front', () => {
    expect(nodeDepth(event(100), 50, 10)).toMatchObject({ depth: 0, when: 'future' })
    expect(nodeDepth(event(100, 200), 150, 10)).toMatchObject({ depth: 0, scale: 1, when: 'now' })
  })

  it('pushes finished events back the longer ago they ended, never out of reach', () => {
    const recent = nodeDepth(event(0, 100), 110, 100)
    const old = nodeDepth(event(0, 100), 1000, 100)
    const ancient = nodeDepth(event(0, 100), 1e12, 100)
    expect(recent.when).toBe('past')
    expect(old.depth).toBeGreaterThan(recent.depth)
    expect(ancient.scale).toBeGreaterThan(0.3)
    expect(ancient.depth).toBeLessThanOrEqual(1)
  })
})

describe('projection helpers', () => {
  it('pulls points toward the vanishing point', () => {
    expect(project(100, 0, 0, 0, 0.5)).toEqual([50, 0])
    expect(project(10, 10, 10, 10, 0.2)).toEqual([10, 10])
  })

  it('stops a line at the edge of the target box', () => {
    expect(boxEdge([0, 0], [100, 0], 20, 10)).toEqual([80, 0])
    expect(boxEdge([100, 100], [100, 0], 20, 10)).toEqual([100, 10])
  })
})
