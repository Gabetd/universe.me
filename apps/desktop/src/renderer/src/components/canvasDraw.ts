import { rng } from '@universe/procgen'

/** Canvas drawing shared by the viewport's levels. */

/** Faint background stars, the same for a seed. */
export function starfield(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, count: number) {
  const r = rng(seed ^ 0x51ed27)
  for (let i = 0; i < count; i++) {
    const x = r() * w
    const y = r() * h
    const s = r() * r() * 1.6 + 0.2
    ctx.fillStyle = `rgba(220,230,255,${0.15 + r() * 0.55})`
    ctx.fillRect(x, y, s, s)
  }
}

/** A name under something on the canvas. */
export function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, highlight: boolean) {
  ctx.font = `${highlight ? 600 : 500} 12px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.fillStyle = highlight ? '#ffffff' : 'rgba(210,220,245,0.8)'
  ctx.fillText(text, x, y)
}
