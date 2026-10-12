import { describe, expect, it } from 'vitest'
import { align, arrowHead, bounds, connectionCurve, curveAt, curveLength, facingSide, freeSpot, nearestSide, pickedPart, snapBox, subCurve } from './board'

const a = { x: 0, y: 0, w: 100, h: 50 }
const b = { x: 300, y: 0, w: 100, h: 50 }

describe('the canvas’s geometry', () => {
  it('connects boxes from the sides facing each other, or the ones given, bending out of them', () => {
    const curve = connectionCurve(a, b, null, null)
    expect(curve.from).toEqual({ x: 100, y: 25 })
    expect(curve.to).toEqual({ x: 300, y: 25 })
    expect(curve.c1.x).toBeGreaterThan(100)
    expect(curve.c2.x).toBeLessThan(300)
    const down = connectionCurve(a, b, 'bottom', 'top')
    expect(down.from).toEqual({ x: 50, y: 50 })
    expect(down.to).toEqual({ x: 350, y: 0 })
    expect(curveAt(curve, 0.5)).toEqual({ x: 200, y: 25 })
    expect(facingSide(a, { x: 50, y: 400 })).toBe('bottom')
    expect(nearestSide(b, { x: 302, y: 30 })).toBe('left')
    // The arrowhead's tip is the curve's end.
    expect(arrowHead(curve, true, 10).startsWith('300,25 ')).toBe(true)
  })

  it('snaps a moved box onto other boxes’ edges and middles, else the grid', () => {
    const moved = { x: 303, y: 77, w: 100, h: 50 }
    const snapped = snapBox(moved, [b], { grid: true, objects: true, slack: 6 })
    expect(snapped.at).toEqual({ x: 300, y: 80 })
    expect(snapped.guides.x).toEqual([300])
    expect(snapBox(moved, [b], { grid: false, objects: false, slack: 6 }).at).toEqual({ x: 303, y: 77 })
  })

  it('finds a free place for a new box near where it was asked', () => {
    expect(freeSpot({ x: 1000, y: 1000 }, { w: 100, h: 50 }, [a])).toEqual({ x: 1000, y: 1000 })
    const p = freeSpot({ x: 50, y: 25 }, { w: 100, h: 50 }, [a])
    expect(Math.abs(p.x - 50) >= 100 || Math.abs(p.y - 25) >= 50).toBe(true)
  })

  it('aligns boxes against the bounds of them all', () => {
    const boxes = [{ id: 'a', ...a }, { id: 'c', x: 40, y: 200, w: 20, h: 20 }]
    expect(bounds(boxes)).toEqual({ x: 0, y: 0, w: 100, h: 220 })
    expect(align(boxes, 'right').get('c')).toEqual({ x: 80, y: 200 })
    expect(align(boxes, 'center').get('c')).toEqual({ x: 40, y: 200 })
    expect(align(boxes, 'bottom').get('a')).toEqual({ x: 0, y: 170 })
  })

  it('picks a line all along but near its ends, where the cards’ handles are', () => {
    const line = { from: { x: 0, y: 0 }, c1: { x: 100, y: 0 }, c2: { x: 200, y: 0 }, to: { x: 300, y: 0 } }
    expect(curveLength(line)).toBeCloseTo(300)
    const part = pickedPart(line, 15)
    expect(part.from.x).toBeCloseTo(15)
    expect(part.to.x).toBeCloseTo(285)
    expect(curveAt(subCurve(line, 0.25, 0.75), 0.5).x).toBeCloseTo(150)
  })
})
