import { AU_KM } from '@universe/core'
import { DAY_S, moonPhase, moonsOf, orbitPath, orbitPosition, positionFromStar, type BodyOrbit, type SystemModel, type Vec3 } from '@universe/sim'
import { drawTexturedPlanet, type PlanetTexture } from './planetSprite'

/**
 * The star-system and planet views (PLAN.md §5.5): bodies where their orbits
 * put them at the timeline's playhead, seen from above at a slant. Distances
 * are drawn on a square-root scale so close-in and far-out orbits both fit.
 */

export interface OrbitTarget {
  id: string
  x: number
  y: number
  r: number
}

export interface OrbitDrawing {
  system: SystemModel
  /** The star (null) or the planet the view is centred on. */
  centerId: string | null
  /** Timeline time, seconds. */
  t: number
  /** Wall-clock seconds, for spinning. */
  spin: number
  names: Map<string, string>
  /** Radius of a body in km (its world's, when it has one). */
  radiusOf(o: BodyOrbit): number
  textureOf(bodyId: string): PlanetTexture | undefined
  hasWorld(bodyId: string): boolean
  /** A colour for bodies without a world. */
  hueOf(bodyId: string): number
  hoverId: string | null
}

const SLANT = 0.45

/** Maps positions (km from the centre) to the screen. */
function projector(cx: number, cy: number, maxPx: number, maxKm: number) {
  return ([x, y, z]: Vec3): [number, number] => {
    const r = Math.hypot(x, y, z)
    if (r === 0) return [cx, cy]
    const k = (maxPx * Math.sqrt(r / maxKm)) / r
    return [cx + x * k, cy - y * k * SLANT - z * k * 0.9]
  }
}

const bodyPx = (radiusKm: number, size: number, scale: number) => Math.max(3, Math.min(size * 0.06, size * scale * (radiusKm / 6371) ** 0.35))

export function drawOrbits(ctx: CanvasRenderingContext2D, w: number, h: number, d: OrbitDrawing): OrbitTarget[] {
  const { system, centerId, t } = d
  const cx = w / 2
  const cy = h / 2 + 10
  const size = Math.min(w, h)
  const targets: OrbitTarget[] = []
  const orbiting = centerId ? moonsOf(system, centerId) : [...system.bodies.values()].filter((o) => !o.parentBodyId)
  const maxKm = Math.max(...orbiting.map((o) => o.semiMajorAxisKm * (1 + o.eccentricity)), centerId ? 400_000 : AU_KM * 1.6) * 1.08
  const maxPx = Math.min(w * 0.46, (h * 0.42) / SLANT)
  const project = projector(cx, cy, maxPx, maxKm)
  const center = centerId ? system.bodies.get(centerId)! : undefined
  // Where the star is, as a screen direction from the centre.
  const starDir = center ? project(positionFromStar(system, center.bodyId, t).map((v) => -v) as Vec3) : ([cx, cy] as [number, number])
  const lightAt = (x: number, y: number) => (center ? Math.atan2(-(starDir[1] - cy), starDir[0] - cx) : Math.atan2(-(cy - y), cx - x))

  if (!center) {
    // The habitable zone, as a faint band.
    const [inner, outer] = system.star.habitableAu.map((au) => maxPx * Math.sqrt(Math.min(au * AU_KM, maxKm * 2) / maxKm))
    ctx.beginPath()
    ctx.ellipse(cx, cy, outer!, outer! * SLANT, 0, 0, Math.PI * 2)
    ctx.ellipse(cx, cy, inner!, inner! * SLANT, 0, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(110, 210, 140, 0.08)'
    ctx.fill('evenodd')
    starGlow(ctx, cx, cy, size * 0.03 * system.star.radiusSun ** 0.4, system.star.color)
  } else {
    // A small sun at the edge shows which way the light comes from.
    const angle = Math.atan2(starDir[1] - cy, starDir[0] - cx)
    const edge = Math.min(w, h) * 0.47
    starGlow(ctx, cx + Math.cos(angle) * edge, cy + Math.sin(angle) * edge * 0.8, 6, system.star.color)
    drawBody(ctx, d, center, cx, cy, bodyPx(d.radiusOf(center), size, 0.12), lightAt(cx, cy), targets, false)
  }

  for (const o of orbiting) {
    ctx.beginPath()
    orbitPath(o).forEach((p, i) => {
      const [x, y] = project(p)
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    })
    ctx.strokeStyle = o.bodyId === d.hoverId ? 'rgba(170,190,255,0.55)' : 'rgba(140,160,220,0.2)'
    ctx.lineWidth = 1
    ctx.stroke()
    const [x, y] = project(orbitPosition(o, t))
    const r = bodyPx(d.radiusOf(o), size, centerId ? 0.035 : 0.02)
    drawBody(ctx, d, o, x, y, r, lightAt(x, y), targets, true)
  }
  return targets
}

function drawBody(ctx: CanvasRenderingContext2D, d: OrbitDrawing, o: BodyOrbit, x: number, y: number, r: number, light: number, targets: OrbitTarget[], labelled: boolean) {
  const surface = d.textureOf(o.bodyId)
  if (surface) drawTexturedPlanet(ctx, x, y, r, surface, d.spin / 90 + (o.phaseDeg % 360) / 360, light)
  else plainBody(ctx, x, y, r, d.hueOf(o.bodyId), light)
  if (d.hasWorld(o.bodyId)) {
    ctx.strokeStyle = 'rgba(140,200,255,0.5)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(x, y, r + 2, 0, Math.PI * 2)
    ctx.stroke()
  }
  targets.push({ id: o.bodyId, x, y, r: r + 4 })
  if (!labelled) return
  const hover = o.bodyId === d.hoverId
  ctx.textAlign = 'center'
  ctx.font = `${hover ? 600 : 500} 12px system-ui, sans-serif`
  ctx.fillStyle = hover ? '#ffffff' : 'rgba(210,220,245,0.85)'
  ctx.fillText(d.names.get(o.bodyId) ?? '', x, y + r + 15)
  ctx.font = '500 10px system-ui, sans-serif'
  ctx.fillStyle = 'rgba(170,182,215,0.75)'
  ctx.fillText(orbitSummary(d.system, o, d.t), x, y + r + 28)
}

/** "1.00 AU · 365 d", or for a moon "384,400 km · 27.3 d · waxing gibbous". */
function orbitSummary(system: SystemModel, o: BodyOrbit, t: number): string {
  const days = o.periodS / DAY_S
  const period = days >= 1000 ? `${(days / 365.25).toFixed(1)} yr` : `${days.toFixed(days < 10 ? 1 : 0)} d`
  if (!o.parentBodyId) return `${(o.semiMajorAxisKm / AU_KM).toFixed(2)} AU · ${period}`
  const phase = moonPhase(system, o, t)
  return `${Math.round(o.semiMajorAxisKm).toLocaleString()} km · ${period} · ${phase.name.toLowerCase()}`
}

function starGlow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string) {
  const g = ctx.createRadialGradient(x, y, radius * 0.2, x, y, radius * 3)
  g.addColorStop(0, '#fffbf0')
  g.addColorStop(0.3, `${color}e6`)
  g.addColorStop(1, 'transparent')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, radius * 3, 0, Math.PI * 2)
  ctx.fill()
}

/** A body with no world: a shaded disc lit from the star's side. */
function plainBody(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, hue: number, light: number) {
  const lx = x + Math.cos(light) * radius * 0.45
  const ly = y - Math.sin(light) * radius * 0.45
  const g = ctx.createRadialGradient(lx, ly, radius * 0.1, x, y, radius)
  g.addColorStop(0, `hsl(${hue} 35% 72%)`)
  g.addColorStop(1, `hsl(${hue} 30% 14%)`)
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
}
