import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { foundDrawn, onStage, useZoom, viewCanvas, zooming, type Spot } from './zoom'

const DURATION_MS = 650
/** Frames sampled along a zoom: the camera's scale grows exponentially, which keyframes' straight lines can't do by themselves. */
const STEPS = 24
/** How big a level draws the thing it's of (a galaxy, a planet), as a share of the view's smaller side, when it doesn't say. */
const FILLS = 0.42
/** How big something gone into or come out of is drawn, likewise, when the view doesn't say. */
const SMALL = 0.05
/** The most one zoom scales by: past this, the far end is too small (or the near end too blurred) to see anyway. */
const MOST = 40

/**
 * Plays a level change as one zoom of one camera: going in, the still of the
 * old view grows until what was gone into fills the screen, and the new level
 * comes in under it from that very spot and size; going out, the still
 * shrinks into where the level above draws what it showed, and that level
 * comes in from zoomed in on it. The wheel does nothing until it's over, so
 * one long push doesn't carry on through the next level too.
 */
export function ZoomStage({ children }: { children: ReactNode }) {
  const transition = useZoom((s) => s.transition)
  const count = useZoom((s) => s.count)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!transition) return
    const { still } = transition
    const stage = host.current!
    const el = view.current!
    stage.appendChild(still)
    // Hidden until it has drawn a frame or two (and so said where things are in it).
    el.style.opacity = '0'
    const playing: Animation[] = []
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        el.style.opacity = ''
        const ends = landing(stage, transition.direction, transition.at)
        // Going in, the old view is the level the thing is small in; going out, the one it fills.
        const [stillIs, viewIs] = transition.direction === 'in' ? (['outer', 'inner'] as const) : (['inner', 'outer'] as const)
        const [stillFrames, viewFrames] = [layer(ends, stillIs, transition.direction), layer(ends, viewIs, transition.direction)]
        still.style.transformOrigin = `${-parseFloat(still.style.left || '0')}px ${-parseFloat(still.style.top || '0')}px`
        el.style.transformOrigin = '0 0'
        // The level shown small has soft edges, so it reads as a place in the other, not a picture laid on it.
        ;(stillIs === 'inner' ? still : el).classList.add('zoom-inner')
        // Held at their ends until the zoom is put away, so neither jumps back first.
        playing.push(still.animate(stillFrames, { duration: DURATION_MS, fill: 'forwards' }), el.animate(viewFrames, { duration: DURATION_MS, fill: 'forwards' }))
        playing[1]!.finished.then(
          () => useZoom.getState().set(null),
          () => {}
        )
      })
    })
    // Should frames not come (a hidden window), the zoom still ends.
    const timer = setTimeout(() => useZoom.getState().transition === transition && useZoom.getState().set(null), DURATION_MS + 1000)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      for (const a of playing) a.cancel()
      still.remove()
      el.style.opacity = ''
      el.classList.remove('zoom-inner')
    }
  }, [transition])

  return (
    <div
      ref={host}
      className="zoom-stage"
      // Capturing at the stage stops the event before it reaches anything in the view, three.js controls included.
      onWheelCapture={(e) => zooming() && e.stopPropagation()}
    >
      <div ref={view} key={count} className={transition ? 'zoom-view zooming' : 'zoom-view'}>
        {children}
      </div>
    </div>
  )
}

/** A thing as drawn in the level it's small in (`outer`) and in the level it fills (`inner`), on the stage. */
interface Ends {
  outer: Required<Spot>
  inner: Required<Spot>
}

/** Where the zoom goes from and to: what was gone into (or come out of) as each level draws it. */
function landing(stage: HTMLElement, direction: 'in' | 'out', at: Spot): Ends {
  const canvas = viewCanvas()
  const box = canvas ? onStage(canvas) : new DOMRect(0, 0, stage.clientWidth, stage.clientHeight)
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const side = Math.min(box.width, box.height) || 1
  // A size of nothing (gone into from where nothing was drawn) says nothing.
  const sized = (r: number | undefined) => (r && r > 1 ? r : side * SMALL)
  if (direction === 'in') return { outer: { ...at, r: sized(at.r) }, inner: { ...middle, r: side * FILLS } }
  const found = foundDrawn()
  const outer = found ? { x: box.x + found.x, y: box.y + found.y, r: sized(found.r) } : { ...middle, r: side * SMALL }
  return { outer, inner: { x: at.x, y: at.y, r: side * FILLS } }
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/**
 * One layer's frames: `outer` is the level the thing is small in, `inner` the
 * one it fills. Along the way (u from 0, the outer level as it is, to 1, the
 * inner one) the camera's scale grows exponentially and the thing glides from
 * where the outer level has it to where the inner one does; the outer level
 * fades as the thing comes to fill the screen, the inner one shows as it does.
 */
function layer({ outer, inner }: Ends, which: 'outer' | 'inner', direction: 'in' | 'out'): Keyframe[] {
  const k = Math.min(MOST, Math.max(1.5, inner.r / outer.r))
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = i / STEPS
    const u = direction === 'in' ? easeInOut(t) : 1 - easeInOut(t)
    const z = k ** u
    const glide = smoothstep(0, 1, u)
    const q = { x: outer.x + (inner.x - outer.x) * glide, y: outer.y + (inner.y - outer.y) * glide }
    const [scale, from, opacity] = which === 'outer' ? [z, outer, 1 - smoothstep(0.55, 0.95, u)] : [z / k, inner, smoothstep(0.1, 0.6, u)]
    const frame: Keyframe = { offset: t, opacity, transform: `translate(${q.x - scale * from.x}px, ${q.y - scale * from.y}px) scale(${scale})` }
    // The inner level's soft edge spreads out past the screen's as it comes to fill it.
    if (which === 'inner') {
      const size = `${100 + 300 * smoothstep(0.85, 1, u)}%`
      frame.maskSize = `${size} ${size}`
    }
    return frame
  })
}
