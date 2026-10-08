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
  if (polygon.length < 3) return false
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

/** The point a fraction `f` of the way along the great circle from `a` to `b`. */
export function slerpLatLon(a: LatLon, b: LatLon, f: number): LatLon {
  const v = (p: LatLon) => [Math.cos(p.lat * RAD) * Math.cos(p.lon * RAD), Math.cos(p.lat * RAD) * Math.sin(p.lon * RAD), Math.sin(p.lat * RAD)]
  const [p, q] = [v(a), v(b)]
  const dot = Math.min(1, Math.max(-1, p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]!))
  const angle = Math.acos(dot)
  if (angle < 1e-9) return { lat: a.lat, lon: a.lon }
  const s = Math.sin(angle)
  const wa = Math.sin((1 - f) * angle) / s
  const wb = Math.sin(f * angle) / s
  const [x, y, z] = [0, 1, 2].map((k) => p[k]! * wa + q[k]! * wb) as [number, number, number]
  return { lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lon: Math.atan2(y, x) / RAD }
}
