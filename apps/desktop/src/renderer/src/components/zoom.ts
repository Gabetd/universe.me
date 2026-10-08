import { ancestry } from '@universe/core'
import type { Claim } from '@universe/sim'
import { create } from 'zustand'
import { useUi } from '../store'

/**
 * Moving between levels of the universe (PLAN.md §5.2) as one continuous
 * zoom: the view being left is frozen, then grows past the camera (going in)
 * or shrinks away (going out) while the next level comes in from the same
 * point. A gesture in the view arms the zoom; the selection changing plays
 * it, in the same update, so the next level mounts once, already arriving.
 */

interface Transition {
  /** A still of the view being left. */
  still: HTMLCanvasElement
  direction: 'in' | 'out'
  /** Where on screen the zoom centres, px from the viewport's top left. */
  x: number
  y: number
}

interface Point {
  x: number
  y: number
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

/** The view's canvas, to freeze for a zoom (the first one in the view). */
const viewCanvas = () => document.querySelector<HTMLCanvasElement>('.zoom-view canvas')

/** The still and centre the next change of level zooms with. */
let armed: { still: HTMLCanvasElement; at: Point } | null = null

/** Freezes `canvas` (the view's own by default) as it is now, for the next change of level to zoom at `at` (its middle by default). */
function arm(canvas: HTMLCanvasElement | null | undefined, at?: Point) {
  const source = canvas ?? viewCanvas()
  if (!source || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const still = document.createElement('canvas')
  still.width = source.width
  still.height = source.height
  still.getContext('2d')!.drawImage(source, 0, 0)
  armed = { still, at: at ?? { x: source.clientWidth / 2, y: source.clientHeight / 2 } }
}

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
  if (!shot) return
  // Up to an ancestor zooms out; anything else (into a child) zooms in.
  const direction = up >= 0 ? 'out' : 'in'
  shot.still.className = `zoom-still ${direction}`
  shot.still.style.transformOrigin = `${shot.at.x}px ${shot.at.y}px`
  useZoom.getState().set({ still: shot.still, direction, ...shot.at })
})

/** Goes to `nodeId`, zooming at `at` on `canvas` (the view's, its middle, by default): in to a child, out to an ancestor. */
export function zoomTo(nodeId: string, canvas?: HTMLCanvasElement | null, at?: Point) {
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
export async function claimInto(claim: Claim, canvas?: HTMLCanvasElement | null, at?: Point) {
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
