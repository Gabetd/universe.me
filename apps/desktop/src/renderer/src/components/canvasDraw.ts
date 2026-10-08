import { rng } from '@universe/procgen'
import { useEffect, useRef, type RefObject } from 'react'

/** Canvas drawing shared by the viewport's levels. */

/** Something clickable on a canvas, in CSS px from its corner. */
export interface CanvasTarget {
  id: string
  x: number
  y: number
  r: number
}

/** The target nearest (x, y) and within its radius (or `slack` px, if that's more). */
export function targetAt<T extends { x: number; y: number; r: number }>(targets: readonly T[], x: number, y: number, slack = 10): T | undefined {
  let best: T | undefined
  let bestD = Infinity
  for (const t of targets) {
    const d = Math.hypot(t.x - x, t.y - y)
    if (d <= Math.max(t.r, slack) && d < bestD) [best, bestD] = [t, d]
  }
  return best
}

/**
 * Draws a canvas every frame: its pixels sized to its box at the screen's
 * density, the context in CSS px. `draw` is told when the canvas was resized
 * (and so cleared), so a view that hasn't changed can skip the frame; the
 * latest `draw` runs each frame, so it can read the component's current state.
 */
export function useCanvasLoop(ref: RefObject<HTMLCanvasElement | null>, draw: (ctx: CanvasRenderingContext2D, w: number, h: number, resized: boolean) => void) {
  const latest = useRef(draw)
  useEffect(() => {
    latest.current = draw
  })
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    let frame = 0
    const render = () => {
      const dpr = window.devicePixelRatio || 1
      const { clientWidth: w, clientHeight: h } = canvas
      const resized = canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)
      if (resized) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      latest.current(ctx, w, h, resized)
      frame = requestAnimationFrame(render)
    }
    frame = requestAnimationFrame(render)
    return () => cancelAnimationFrame(frame)
  }, [ref])
}

/** Background stars of each seed and size, drawn once. */
const fields = new Map<string, HTMLCanvasElement>()

/** Faint background stars, the same for a seed. */
export function starfield(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, count: number) {
  const dpr = window.devicePixelRatio || 1
  const key = `${seed}:${count}:${w}x${h}@${dpr}`
  let field = fields.get(key)
  if (!field) {
    field = document.createElement('canvas')
    field.width = Math.round(w * dpr)
    field.height = Math.round(h * dpr)
    const c = field.getContext('2d')!
    c.scale(dpr, dpr)
    const r = rng(seed ^ 0x51ed27)
    for (let i = 0; i < count; i++) {
      const x = r() * w
      const y = r() * h
      const s = r() * r() * 1.6 + 0.2
      c.fillStyle = `rgba(220,230,255,${0.15 + r() * 0.55})`
      c.fillRect(x, y, s, s)
    }
    if (fields.size >= 8) fields.delete(fields.keys().next().value!)
    fields.set(key, field)
  }
  ctx.drawImage(field, 0, 0, w, h)
}

/** A name under something on the canvas. */
export function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, highlight: boolean) {
  ctx.font = `${highlight ? 600 : 500} 12px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.fillStyle = highlight ? '#ffffff' : 'rgba(210,220,245,0.8)'
  ctx.fillText(text, x, y)
}

/** A line of detail under a label. */
export function sublabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  ctx.font = '500 10px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(170,182,215,0.75)'
  ctx.fillText(text, x, y)
}

/** A circle round something: what's yours, what has a world, what's under the cursor. */
export function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, width: number) {
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.stroke()
}

/** A star's glow: a white-hot core in its colour (a #rrggbb), fading out over three times `radius`. */
export function starGlow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string) {
  const g = ctx.createRadialGradient(x, y, radius * 0.2, x, y, radius * 3)
  g.addColorStop(0, '#fffbf0')
  g.addColorStop(0.3, `${color}e6`)
  g.addColorStop(1, 'transparent')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, radius * 3, 0, Math.PI * 2)
  ctx.fill()
}
