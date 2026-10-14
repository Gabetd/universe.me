import { ancestry } from '@universe/core'
import type { Claim } from '@universe/sim'
import { create } from 'zustand'
import { useUi } from '../store'

/**
 * Moving between levels of the universe (PLAN.md §5.2) as one continuous
 * zoom: the view being left is frozen, then grows until what was gone into
 * fills the view (going in), or shrinks into where the level above draws it
 * (going out), while the next level comes in matched to it, so the one
 * camera seems to fly through both (ZoomStage). A gesture in the view arms
 * the zoom; the selection changing plays it, in the same update, so the next
 * level mounts once, already arriving.
 */

/** A spot on screen, px from the top left of what it's on, and how big what's there is drawn (a radius), where that's known. */
export interface Spot {
  x: number
  y: number
  r?: number
}

export interface Transition {
  /** A still of the view being left, placed where its canvas was on the stage. */
  still: HTMLCanvasElement
  direction: 'in' | 'out'
  /** On the stage: going in, what's gone into, where it was drawn; going out, the middle of the view being left. */
  at: Spot
}

/**
 * The zoom in progress, if any, and a count of zooms so far: the view is
 * re-keyed on each new zoom (so its arrival plays from the start) but not when
 * one ends, which would remount it.
 */
export const useZoom = create<{ transition: Transition | null; count: number; set(t: Transition | null): void }>((set) => ({
  transition: null,
  count: 0,
  set: (transition) => set((s) => ({ transition, count: transition ? s.count + 1 : s.count }))
}))

/** A zoom is still playing (the wheel is ignored meanwhile, so one push doesn't carry on through the next level too). */
export const zooming = () => useZoom.getState().transition !== null

/** The view's canvas, to freeze for a zoom and to find the middle of (the first one in the view). */
export const viewCanvas = () => document.querySelector<HTMLCanvasElement>('.zoom-view canvas')

/** Where an element is, px from the zoom stage's top left. */
export function onStage(el: Element): DOMRect {
  const box = el.getBoundingClientRect()
  const stage = el.closest('.zoom-stage')?.getBoundingClientRect()
  return new DOMRect(box.left - (stage?.left ?? 0), box.top - (stage?.top ?? 0), box.width, box.height)
}

/** The still and the spot the next change of level zooms with. */
let armed: { still: HTMLCanvasElement; at: Spot } | null = null

/** Freezes `canvas` (the view's own by default) as it is now, for the next change of level to zoom at `at` on it (its middle by default). */
function arm(canvas: HTMLCanvasElement | null | undefined, at?: Spot) {
  const source = canvas ?? viewCanvas()
  // A view with no size (hidden, as behind another panel on a phone) has nothing to show.
  if (!source?.width || !source.height || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const still = document.createElement('canvas')
  still.width = source.width
  still.height = source.height
  still.getContext('2d')!.drawImage(source, 0, 0)
  const box = onStage(source)
  // Where its canvas was; scaled about the stage's top left, as the view under it is.
  Object.assign(still.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`, transformOrigin: `${-box.x}px ${-box.y}px` })
  armed = { still, at: { x: box.x + (at?.x ?? box.width / 2), y: box.y + (at?.y ?? box.height / 2), r: at?.r } }
}

/**
 * Where the level being zoomed to draws the node the zoom comes from (going
 * out): the views say, as they draw, by `noteDrawn`.
 */
const sought: { id: string | null; found: Spot | null } = { id: null, found: null }

/** A view drew node `id` at (x, y) on its canvas, `r` across: if a zoom out is landing on it, that's where. */
export function noteDrawn(id: string | null | undefined, x: number, y: number, r: number): void {
  if (id && id === sought.id) sought.found = { x, y, r }
}

/** Where the node a zoom out is looking for was drawn, on its view's canvas, if it has been. */
export const foundDrawn = () => sought.found

/**
 * Coming up a level: the child it came up through, for the level above to look
 * at first. Set on every change of selection, so it's never stale.
 */
export const arrival: { fromId: string | null } = { fromId: null }

useUi.subscribe((s, prev) => {
  if (s.selectedId === prev.selectedId) return
  const path = prev.selectedId ? ancestry(prev.nodes, prev.selectedId) : []
  const up = path.findIndex((n) => n.id === s.selectedId)
  arrival.fromId = up >= 0 ? (path[up + 1]?.id ?? null) : null
  const shot = armed
  armed = null
  // Up to an ancestor zooms out, down into something in it zooms in; going sideways (to a sibling, say) just goes.
  const down = !!s.selectedId && !!prev.selectedId && ancestry(s.nodes, s.selectedId).some((n) => n.id === prev.selectedId)
  if (!shot || (up < 0 && !down)) return
  shot.still.className = 'zoom-still'
  sought.id = up >= 0 ? arrival.fromId : null
  sought.found = null
  useZoom.getState().set({ still: shot.still, direction: up >= 0 ? 'out' : 'in', at: shot.at })
})

/** Goes to `nodeId`, zooming at `at` on `canvas` (the view's, its middle, by default): in to what's in it, out to what it's in. */
export function zoomTo(nodeId: string, canvas?: HTMLCanvasElement | null, at?: Spot) {
  arm(canvas, at)
  useUi.getState().select(nodeId)
  armed = null
}

/** Goes up a level (or to the ancestor `toId`), zooming out from the middle of the view. */
export function zoomOut(canvas?: HTMLCanvasElement | null, toId?: string) {
  const { nodes, selectedId } = useUi.getState()
  const target = toId ?? nodes.find((n) => n.id === selectedId)?.parentId
  if (target) zoomTo(target, canvas)
}

/** Claims something generated and goes into it, zooming at where it was on `canvas`. */
export async function claimInto(claim: Claim, canvas?: HTMLCanvasElement | null, at?: Spot) {
  arm(canvas, at)
  // The batch lands on what it made, which plays the zoom.
  await useUi.getState().execute(claim.command)
  armed = null
}

/**
 * Pushes of the wheel past either end of a level's zoom: a few in a row (about
 * three notches' worth) change level.
 */
export class EdgePush {
  private sum = 0

  /** `amount` pushes in (negative) or out (positive) past the edge, 0 inside it; true once there have been enough in one direction. */
  push(amount: number): boolean {
    this.sum = amount && Math.sign(amount) === Math.sign(this.sum) ? this.sum + amount : amount
    if (Math.abs(this.sum) < 3) return false
    this.sum = 0
    return true
  }
}

/**
 * Cameras of the zoomable levels (universe, cluster, galaxy), per node: where
 * each was looking, so coming back finds it as it was. Going up from a child
 * centres its parent's camera on the child.
 */
export interface Camera {
  x: number
  y: number
  /** Level units per screen pixel. */
  upp: number
}

export const cameras = new Map<string, Camera>()
