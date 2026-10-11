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
 */

/** The speeds to pick from, in metres a second. */
export const GROUND_SPEEDS = [
  { id: 'walk', label: 'Walk', mps: 6 },
  { id: 'run', label: 'Run', mps: 20 },
  { id: 'ride', label: 'Ride', mps: 60 },
  { id: 'fly', label: 'Fly', mps: 250 }
] as const
export type GroundSpeed = (typeof GROUND_SPEEDS)[number]['id']

const SHIFT_FACTOR = 3

/** Which way each key moves: [forward, right]. */
const KEYS: Record<string, [number, number]> = {
  KeyW: [1, 0],
  ArrowUp: [1, 0],
  KeyS: [-1, 0],
  ArrowDown: [-1, 0],
  KeyA: [0, -1],
  ArrowLeft: [0, -1],
  KeyD: [0, 1],
  ArrowRight: [0, 1]
}

/** Keys held down, and Shift. Only while nothing that takes typing has focus and no dialog is open. */
function useHeldKeys() {
  const held = useRef(new Set<string>())
  const shift = useRef(false)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      shift.current = e.shiftKey
      if (!(e.code in KEYS) || e.ctrlKey || e.metaKey || e.altKey || isEditingText() || document.querySelector('.modal-backdrop')) return
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
    let f = 0
    let r = 0
    for (const code of held.current) {
      f += KEYS[code]![0]
      r += KEYS[code]![1]
    }
    // Along the ground, the way the camera faces.
    forward.subVectors(target, camera.position).setY(0)
    if (forward.lengthSq() < 1e-6) camera.getWorldDirection(forward).setY(0)
    forward.normalize()
    right.crossVectors(forward, UP).normalize()
    step.copy(forward).multiplyScalar(f).addScaledVector(right, r)
    if (step.lengthSq() > 0) {
      const mps = GROUND_SPEEDS.find((s) => s.id === useEditor.getState().groundSpeed)!.mps * (shift.current ? SHIFT_FACTOR : 1)
      // A long frame (the window hidden a moment) doesn't jump.
      step.normalize().multiplyScalar(mps * Math.min(delta, 0.1))
      camera.position.add(step)
      target.add(step)
    }
    // Keep drawing while a key is held.
    invalidate()
  })
  return null
}
