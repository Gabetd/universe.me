import type { LatLon } from '@universe/core'
import { brushRows, latLonToDir, latLonToPixel, pixelToLatLon, renderEquirect, type Vec3 } from '@universe/procgen'
import { useEffect, useRef } from 'react'
import { useUi } from '../store'
import { SPACE_BG } from '../theme'
import { isBrushTool, useEditor } from './editorStore'
import type { SurfaceViewProps } from './useTerrain'

const W = 1024
const H = 512

interface View {
  scale: number
  ox: number
  oy: number
}

/** Map pixel coordinates of a point, with longitude unwrapped near `refX` so shapes crossing ±180° stay whole. */
function toMap(p: LatLon, refX?: number): [number, number] {
  const [x, y] = latLonToPixel(p.lat, p.lon, W, H)
  return [refX === undefined ? x : x + Math.round((refX - x) / W) * W, y]
}

function polygon(points: LatLon[]): [number, number][] {
  const out: [number, number][] = []
  for (const p of points) out.push(toMap(p, out[out.length - 1]?.[0]))
  return out
}

function insidePolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!
    const [xj, yj] = poly[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function MapView({ model, change, regions, pins, highlightRegionIds, onPinClick, onPointerDown, onPointerMove, onDoubleClick }: SurfaceViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const terrain = useRef<{ canvas: HTMLCanvasElement; image: ImageData } | null>(null)
  const view = useRef<View | null>(null)
  const hover = useRef<[number, number] | null>(null)
  const pan = useRef<{ x: number; y: number } | null>(null)
  const dirty = useRef(true)
  const selectedRegionId = useUi((s) => s.selectedRegionId)
  const draft = useEditor((s) => s.draft)

  // Re-render the terrain image: just the rows the last dab touched, or all of it.
  useEffect(() => {
    if (!terrain.current) {
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      terrain.current = { canvas, image: new ImageData(W, H) }
    }
    const { canvas, image } = terrain.current
    const [y0, y1] = change.dab ? brushRows(change.dab.dir, change.dab.radius, H) : [0, H]
    renderEquirect(model, image.data, W, H, y0, y1)
    canvas.getContext('2d')!.putImageData(image, 0, 0, 0, Math.max(0, y0), W, Math.min(H, y1) - Math.max(0, y0))
    dirty.current = true
  }, [model, change])

  useEffect(() => {
    dirty.current = true
  }, [regions, selectedRegionId, draft, pins, highlightRegionIds])

  // Bring the selected event's pin to the middle of the view.
  const focus = pins.find((p) => p.selected)
  const focusKey = focus && `${focus.eventId}:${focus.lat}:${focus.lon}`
  useEffect(() => {
    const v = view.current
    const canvas = canvasRef.current
    if (!focus || !v || !canvas) return
    const [x, y] = toMap(focus)
    v.ox = canvas.clientWidth / 2 - x * v.scale
    v.oy = canvas.clientHeight / 2 - y * v.scale
    dirty.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new focus point should move the view
  }, [focusKey])

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let frame = 0
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const dpr = window.devicePixelRatio || 1
      const { clientWidth: cw, clientHeight: ch } = canvas
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr)
        canvas.height = Math.round(ch * dpr)
        dirty.current = true
      }
      if (!view.current && cw > 0) {
        const scale = Math.min(cw / W, ch / H)
        view.current = { scale, ox: (cw - W * scale) / 2, oy: (ch - H * scale) / 2 }
      }
      if (!dirty.current || !view.current || !terrain.current) return
      dirty.current = false
      const v = view.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = SPACE_BG
      ctx.fillRect(0, 0, cw, ch)
      ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.ox, dpr * v.oy)
      ctx.imageSmoothingEnabled = v.scale < 2
      // Draw the map and its neighbors so panning sideways wraps around the planet.
      for (const shift of [-W, 0, W]) {
        ctx.drawImage(terrain.current.canvas, shift, 0)
        drawOverlays(ctx, shift, v.scale)
      }
    }

    const drawOverlays = (c: CanvasRenderingContext2D, shift: number, scale: number) => {
      const { selectedRegionId: sel } = useUi.getState()
      const { draft: points, tool, radiusKm } = useEditor.getState()
      c.lineJoin = 'round'
      for (const region of regions) {
        const poly = polygon(region.points)
        const lit = region.id === sel || highlightRegionIds.has(region.id)
        tracePath(c, poly, shift)
        c.closePath()
        c.fillStyle = `${region.color}${lit ? '55' : '33'}`
        c.fill()
        c.strokeStyle = highlightRegionIds.has(region.id) ? '#ffffff' : region.color
        c.lineWidth = (lit ? 3 : 1.5) / scale
        c.stroke()
        const [cx, cy] = centroid(poly)
        c.font = `${600} ${12 / scale}px system-ui, sans-serif`
        c.textAlign = 'center'
        c.fillStyle = '#ffffff'
        c.fillText(region.name, cx + shift, cy)
      }
      if (points.length) {
        const poly = polygon(points)
        tracePath(c, poly, shift)
        c.setLineDash([6 / scale, 4 / scale])
        c.strokeStyle = '#ffffff'
        c.lineWidth = 2 / scale
        c.stroke()
        c.setLineDash([])
        for (const [x, y] of poly) {
          c.fillStyle = '#ffffff'
          c.fillRect(x + shift - 2.5 / scale, y - 2.5 / scale, 5 / scale, 5 / scale)
        }
      }
      for (const pin of pins) {
        const [x, y] = toMap(pin)
        const r = (pin.selected ? 6 : pin.active ? 5 : 3.5) / scale
        c.globalAlpha = pin.selected || pin.active ? 1 : 0.55
        c.beginPath()
        c.arc(x + shift, y, r, 0, Math.PI * 2)
        c.fillStyle = pin.color
        c.fill()
        c.strokeStyle = pin.selected ? '#ffffff' : '#05070d'
        c.lineWidth = 1.5 / scale
        c.stroke()
        c.globalAlpha = 1
        if (pin.selected || pin.active) {
          c.font = `${pin.selected ? 700 : 500} ${12 / scale}px system-ui, sans-serif`
          c.textAlign = 'left'
          c.fillStyle = '#ffffff'
          c.fillText(pin.title, x + shift + r + 4 / scale, y + 4 / scale)
        }
      }
      const h = hover.current
      if (h && isBrushTool(tool)) {
        // The brush is a circle on the planet, so it stretches east-west toward the poles.
        const lat = pixelToLatLon(h[0], h[1], W, H).lat
        const ry = (model.angularRadius(radiusKm) / Math.PI) * H
        const rx = Math.min(W / 2, ry / Math.max(0.05, Math.cos((lat * Math.PI) / 180)))
        c.beginPath()
        c.ellipse(h[0] + shift, h[1], rx, ry, 0, 0, Math.PI * 2)
        c.strokeStyle = 'rgba(255,255,255,0.9)'
        c.lineWidth = 1.5 / scale
        c.stroke()
      }
    }

    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [model, regions, pins, highlightRegionIds])

  /** Pointer position in map pixels (x wrapped to [0, W)), or null outside the map vertically. */
  const mapPoint = (e: React.PointerEvent | React.MouseEvent): [number, number] | null => {
    const v = view.current
    if (!v) return null
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = (e.clientX - rect.left - v.ox) / v.scale
    const y = (e.clientY - rect.top - v.oy) / v.scale
    if (y < 0 || y >= H) return null
    return [((x % W) + W) % W, y]
  }

  const dirAt = ([x, y]: [number, number]): Vec3 => {
    const { lat, lon } = pixelToLatLon(x, y, W, H)
    return latLonToDir(lat, lon)
  }

  return (
    <canvas
      ref={canvasRef}
      className="map-canvas"
      data-testid="map"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        const p = mapPoint(e)
        const tool = useEditor.getState().tool
        if (e.button === 0 && p && onPointerDown(dirAt(p))) return
        if (e.button === 0 && p && tool === 'navigate') {
          const v = view.current!
          // Pins are small, so they win over the region they sit in; 8 screen pixels of slack.
          const pin = pins.find((pn) => {
            const [x, y] = toMap(pn)
            return [-W, 0, W].some((s) => Math.hypot((x + s - p[0]) * v.scale, (y - p[1]) * v.scale) <= 8)
          })
          if (pin) return onPinClick(pin.eventId)
          const hit = regions.find((r) => [-W, 0, W].some((s) => insidePolygon(p[0] + s, p[1], polygon(r.points))))
          useUi.getState().selectRegion(hit?.id ?? null)
        }
        pan.current = { x: e.clientX, y: e.clientY }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const p = mapPoint(e)
        hover.current = p
        dirty.current = true
        if (pan.current && view.current) {
          view.current.ox += e.clientX - pan.current.x
          view.current.oy += e.clientY - pan.current.y
          pan.current = { x: e.clientX, y: e.clientY }
        } else if (p) onPointerMove(dirAt(p))
      }}
      onPointerUp={() => (pan.current = null)}
      onPointerLeave={() => ((hover.current = null), (dirty.current = true))}
      onDoubleClick={onDoubleClick}
      onWheel={(e) => {
        const v = view.current
        if (!v) return
        const rect = canvasRef.current!.getBoundingClientRect()
        const sx = e.clientX - rect.left
        const sy = e.clientY - rect.top
        const next = Math.max(0.3, Math.min(12, v.scale * Math.exp(-e.deltaY * 0.0015)))
        // Zoom around the cursor.
        v.ox = sx - ((sx - v.ox) * next) / v.scale
        v.oy = sy - ((sy - v.oy) * next) / v.scale
        v.scale = next
        dirty.current = true
      }}
    />
  )
}

function tracePath(c: CanvasRenderingContext2D, poly: [number, number][], shift: number): void {
  c.beginPath()
  poly.forEach(([x, y], i) => (i ? c.lineTo(x + shift, y) : c.moveTo(x + shift, y)))
}

function centroid(poly: [number, number][]): [number, number] {
  let x = 0
  let y = 0
  for (const [px, py] of poly) {
    x += px
    y += py
  }
  return [x / poly.length, y / poly.length]
}
