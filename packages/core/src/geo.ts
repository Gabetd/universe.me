import type { LatLon } from './world'

const RAD = Math.PI / 180

/** Distance along the surface between two points on a sphere of `radiusKm`. */
export function greatCircleKm(a: LatLon, b: LatLon, radiusKm: number): number {
  const dLat = (b.lat - a.lat) * RAD
  const dLon = (b.lon - a.lon) * RAD
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2
  return 2 * radiusKm * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Whether a point is inside a lat/lon polygon. Longitudes are unwrapped around the polygon, so shapes across ±180° work. */
export function insidePolygon(p: LatLon, polygon: LatLon[]): boolean {
  return polygonTester(polygon)(p)
}

/** The longitude `lon` names, moved by whole turns to within 180° of `ref`. */
const unwrap = (lon: number, ref: number) => lon + Math.round((ref - lon) / 360) * 360

/**
 * `insidePolygon` for one polygon and many points: the polygon is unwrapped
 * once, and points outside its bounds are turned away before the ray test.
 */
export function polygonTester(polygon: LatLon[]): (p: LatLon) => boolean {
  if (polygon.length < 3) return () => false
  const pts: [number, number][] = []
  for (const q of polygon) pts.push([unwrap(q.lon, pts[pts.length - 1]?.[0] ?? q.lon), q.lat])
  const mid = pts.reduce((s, q) => s + q[0], 0) / pts.length
  // Off to the side of the outline, a point crosses its edges an even number of times (or none), so it's outside.
  // The x bounds get a margin for the rounding of the crossing points.
  let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity]
  for (const [x, y] of pts) {
    minX = Math.min(minX, x - 1e-6)
    maxX = Math.max(maxX, x + 1e-6)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  return (p) => {
    if (p.lat < minY || p.lat > maxY) return false
    const x = unwrap(p.lon, mid)
    if (x < minX || x > maxX) return false
    let inside = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i]!
      const [xj, yj] = pts[j]!
      if (yi > p.lat !== yj > p.lat && x < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
}

type Vector = [number, number, number]

/** A point as a unit vector: x towards lat 0, lon 0, and z towards the north pole. */
export function toUnitVector(p: LatLon): Vector {
  const lat = (p.lat * Math.PI) / 180
  const lon = (p.lon * Math.PI) / 180
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
}

/** The point a vector (of any length) points to. */
export function fromVector([x, y, z]: Vector): LatLon {
  return { lat: (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI, lon: (Math.atan2(y, x) * 180) / Math.PI }
}

/** The point a fraction `f` of the way along the great circle from `a` to `b`. */
export function slerpLatLon(a: LatLon, b: LatLon, f: number): LatLon {
  const [p, q] = [toUnitVector(a), toUnitVector(b)]
  const dot = Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]))
  const angle = Math.acos(dot)
  if (angle < 1e-9) return { lat: a.lat, lon: a.lon }
  const s = Math.sin(angle)
  const wa = Math.sin((1 - f) * angle) / s
  const wb = Math.sin(f * angle) / s
  return fromVector([p[0] * wa + q[0] * wb, p[1] * wa + q[1] * wb, p[2] * wa + q[2] * wb])
}
