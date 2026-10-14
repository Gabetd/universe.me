import { describe, expect, it } from 'vitest'
import { countOverlaps, declutter, labelRoom, overlapping, type Disc } from './declutter'

const noneOverlap = (placed: ReturnType<typeof declutter>) => placed.every((a, i) => placed.every((b, j) => j <= i || !overlapping(a, b)))

describe('keeping what’s drawn in space apart', () => {
  it('shrinks what crowds, leaves out generated specks with no room, and nudges your own things clear; nothing overlaps', () => {
    const discs: Disc[] = [
      { x: 100, y: 100, r: 20, priority: 1 },
      { x: 115, y: 100, r: 10, priority: 0 },
      { x: 100, y: 100, r: 6, priority: 0 },
      { x: 101, y: 101, r: 8, priority: 5, keep: true },
      { x: 300, y: 300, r: 30, priority: 0 }
    ]
    const placed = declutter(discs)
    expect(noneOverlap(placed)).toBe(true)
    expect(countOverlaps(placed)).toBe(0)
    expect(countOverlaps(discs.map((d) => ({ ...d, hidden: false })))).toBeGreaterThan(3)
    // The kept one is where it was; the far one untouched.
    expect(placed[3]).toMatchObject({ x: 101, y: 101, r: 8, hidden: false })
    expect(placed[4]).toEqual({ x: 300, y: 300, r: 30, hidden: false })
    expect(placed.some((p) => p.hidden)).toBe(true)
    // A crowd of kept things on one spot all show, apart.
    const crowd = declutter(Array.from({ length: 12 }, () => ({ x: 50, y: 50, r: 6, priority: 0, keep: true })))
    expect(crowd.every((p) => !p.hidden)).toBe(true)
    expect(noneOverlap(crowd)).toBe(true)
  })

  it('shows a label only where it’s clear of those shown before it', () => {
    const room = labelRoom()
    expect(room(100, 100, 60, 12)).toBe(true)
    expect(room(110, 104, 60, 12)).toBe(false)
    expect(room(100, 140, 60, 12)).toBe(true)
  })
})
