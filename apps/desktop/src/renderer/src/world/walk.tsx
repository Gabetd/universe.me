import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { isEditingText } from '../input'
import { useEditor } from './editorStore'

/**
 * Moving over the ground with the keyboard: W, A, S and D (or the arrows)
 * go forward, left, back and right, as the camera faces, at the speed picked
 * in the toolbar (`GROUND_SPEEDS`); Shift goes three times as fast. The
 * camera and what it looks at move together, so the view keeps its angle.
 * Space rises and Ctrl comes down, as far as the ground.
 */

/** The speeds to pick from, in metres a second: quick enough to cross a world, Fly going over the whole 12 km view in a second. */
export const GROUND_SPEEDS = [
  { id: 'walk', label: 'Walk', mps: 300 },
  { id: 'run', label: 'Run', mps: 1000 },
  { id: 'ride', label: 'Ride', mps: 3000 },
  { id: 'fly', label: 'Fly', mps: 12_500 }
] as const
export type GroundSpeed = (typeof GROUND_SPEEDS)[number]['id']

const SHIFT_FACTOR = 3
/** Rising and coming down go at this share of the speed. */
const CLIMB_FACTOR = 0.25

/** Which way each key moves: [forward, right, up]. */
const KEYS: Record<string, [number, number, number]> = {
  KeyW: [1, 0, 0],
  ArrowUp: [1, 0, 0],
  KeyS: [-1, 0, 0],
  ArrowDown: [-1, 0, 0],
  KeyA: [0, -1, 0],
  ArrowLeft: [0, -1, 0],
  KeyD: [0, 1, 0],
  ArrowRight: [0, 1, 0],
  Space: [0, 0, 1],
  ControlLeft: [0, 0, -1],
  ControlRight: [0, 0, -1]
}
const isControl = (code: string) => code === 'ControlLeft' || code === 'ControlRight'

/** Keys held down, and Shift. Only while nothing that takes typing has focus and no dialog is open. */
function useHeldKeys() {
  const held = useRef(new Set<string>())
  const shift = useRef(false)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      shift.current = e.shiftKey
      // Ctrl itself comes down; held with another key, it's a shortcut's.
      if (!(e.code in KEYS) || (e.ctrlKey && !isControl(e.code)) || e.metaKey || e.altKey || isEditingText() || document.querySelector('.modal-backdrop')) return
      // Before the shortcuts: S moves back here, it doesn't pick Smooth.
      e.preventDefault()
      e.stopPropagation()
      held.current.add(e.code)
      invalidate()
    }
    const up = (e: KeyboardEvent) => {
      shift.current = e.shiftKey
      held.current.delete(e.code)
    }
    const letGo = () => held.current.clear()
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', letGo)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', letGo)
    }
  }, [invalidate])
  return { held, shift }
}

const forward = new THREE.Vector3()
const right = new THREE.Vector3()
const step = new THREE.Vector3()
const offset = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

/** In the ground view's scene: moves the camera and its target while movement keys are held. */
export function WalkKeys() {
  const { held, shift } = useHeldKeys()
  const get = useThree((s) => s.get)
  useFrame((_, delta) => {
    if (!held.current.size) return
    const { camera, controls, invalidate } = get()
    const target = (controls as unknown as { target?: THREE.Vector3 } | null)?.target
    if (!target) return
    let [f, r, u] = [0, 0, 0]
    for (const code of held.current) {
      const [df, dr, du] = KEYS[code]!
      f += df
      r += dr
      u += du
    }
    const mps = GROUND_SPEEDS.find((s) => s.id === useEditor.getState().groundSpeed)!.mps * (shift.current ? SHIFT_FACTOR : 1)
    // A long frame (the window hidden a moment) doesn't jump.
    const dt = Math.min(delta, 0.1)
    // Up rises straight up, over what the view looks at (which stays on the ground); down comes down along the line of sight to it,
    // the view keeping its angle, so it reaches the ground (the controls keep the camera from going under the horizon, and the rig above the ground).
    const climb = Math.sign(u) * mps * CLIMB_FACTOR * dt
    if (climb > 0) camera.position.y += climb
    else if (climb < 0) {
      offset.subVectors(camera.position, target)
      camera.position.copy(target).addScaledVector(offset, offset.y > 0 ? Math.max(0, 1 + climb / offset.y) : 1)
    }
    // Along the ground, the way the camera faces.
    forward.subVectors(target, camera.position).setY(0)
    if (forward.lengthSq() < 1e-6) camera.getWorldDirection(forward).setY(0)
    forward.normalize()
    right.crossVectors(forward, UP).normalize()
    step.copy(forward).multiplyScalar(f).addScaledVector(right, r)
    if (step.lengthSq() > 0) {
      step.normalize().multiplyScalar(mps * dt)
      camera.position.add(step)
      target.add(step)
    }
    // Keep drawing while a key is held.
    invalidate()
  })
  return null
}
