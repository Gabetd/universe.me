import { describe, expect, it } from 'vitest'
import { insidePolygon, polygonTester, type LatLon } from './index'

/** The ray test without the bounds check, unwrapping on every call. */
function plainInside(p: LatLon, polygon: LatLon[]): boolean {
  const unwrap = (lon: number, ref: number) => lon + Math.round((ref - lon) / 360) * 360
  const pts: [number, number][] = []
  for (const q of polygon) pts.push([unwrap(q.lon, pts[pts.length - 1]?.[0] ?? q.lon), q.lat])
  const x = unwrap(p.lon, pts.reduce((s, q) => s + q[0], 0) / pts.length)
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!
    const [xj, yj] = pts[j]!
    if (yi > p.lat !== yj > p.lat && x < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

let seed = 11
const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 0x100000000

describe('point in polygon', () => {
  it('agrees with the plain ray test, across the date line and on the bounds', () => {
    for (let k = 0; k < 40; k++) {
      // Star-shaped outlines, some straddling ±180°.
      const lat = random() * 120 - 60
      const lon = k % 4 === 0 ? 175 + random() * 10 : random() * 360 - 180
      const n = 3 + Math.floor(random() * 12)
      const polygon = Array.from({ length: n }, (_, i) => {
        const a = (i / n) * 2 * Math.PI
        const r = 2 + random() * 10
        return { lat: lat + r * Math.sin(a), lon: (((lon + r * Math.cos(a) + 540) % 360) - 180) }
      })
      const inside = polygonTester(polygon)
      const probes = [...polygon, ...Array.from({ length: 200 }, () => ({ lat: lat + (random() - 0.5) * 30, lon: (((lon + (random() - 0.5) * 30 + 540) % 360) - 180) }))]
      for (const p of probes) {
        expect(inside(p)).toBe(plainInside(p, polygon))
        expect(insidePolygon(p, polygon)).toBe(plainInside(p, polygon))
      }
    }
    expect(polygonTester([{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }])({ lat: 0.5, lon: 0.5 })).toBe(false)
  })
})
