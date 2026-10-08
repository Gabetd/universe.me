import type { Command } from '@universe/core'
import { create } from 'zustand'
import { useUi } from '../store'

/**
 * Moving between levels of the universe (PLAN.md §5.2) as one continuous
 * zoom: the view being left is frozen, then grows past the camera (going in)
 * or shrinks away (going out) while the next level comes in from the same
 * point. The next level's camera picks up where the last one was looking.
 */

export interface Transition {
  /** A still of the view being left. */
  still: HTMLCanvasElement
  direction: 'in' | 'out'
  /** Where on screen the zoom centres, px from the viewport's top left. */
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

/** A zoom is still playing: the wheel keeps turning for a moment, and shouldn't carry on through the next level too. */
export const zooming = () => useZoom.getState().transition !== null

/** Freezes `canvas` as it is now and starts the zoom toward (x, y). */
export function startTransition(canvas: HTMLCanvasElement | null, direction: 'in' | 'out', x: number, y: number) {
  if (!canvas) return
  const still = document.createElement('canvas')
  still.width = canvas.width
  still.height = canvas.height
  still.getContext('2d')!.drawImage(canvas, 0, 0)
  still.className = `zoom-still ${direction}`
  still.style.transformOrigin = `${x}px ${y}px`
  useZoom.getState().set({ still, direction, x, y })
}

/** Goes into a node (a child of the one in view), zooming toward where it is on screen. */
export function zoomInto(canvas: HTMLCanvasElement | null, nodeId: string, x: number, y: number) {
  startTransition(canvas, 'in', x, y)
  useUi.getState().select(nodeId)
}

/** Makes something (`commands` create node `id`), then goes into it from where it was on screen. */
export async function claimInto(canvas: HTMLCanvasElement | null, commands: Command[], id: string, x: number, y: number) {
  if (await useUi.getState().execute({ type: 'batch', payload: { commands } })) zoomInto(canvas, id, x, y)
}

/** The view's canvas, to freeze for a zoom (the first one in the view). */
export const viewCanvas = () => document.querySelector<HTMLCanvasElement>('.zoom-view canvas')

/** Coming up a level: the child it came up through, for the level above to look at first. */
export const arrival: { fromId: string | null } = { fromId: null }

/** Goes up to the parent level (or further, to the ancestor `toId`), zooming out from the middle of the view. */
export function zoomOut(canvas: HTMLCanvasElement | null, toId?: string) {
  const { nodes, selectedId, select } = useUi.getState()
  const byId = (id: string | null) => nodes.find((n) => n.id === id)
  let from = byId(selectedId)
  const target = toId ?? from?.parentId
  if (!target || target === selectedId) return
  while (from && from.parentId !== target) from = byId(from.parentId)
  arrival.fromId = from?.id ?? null
  if (canvas) startTransition(canvas, 'out', canvas.clientWidth / 2, canvas.clientHeight / 2)
  select(target)
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
