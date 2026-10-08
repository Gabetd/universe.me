import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect } from 'react'
import type * as THREE from 'three'

/** Tints terrain materials (their colours are multiplied by `color`), drawing a frame when it changes. */
export function useLandTint(materials: readonly THREE.MeshStandardMaterial[], color: string) {
  const invalidate = useThree((s) => s.invalidate)
  useLayoutEffect(() => {
    for (const m of materials) m.color.set(color)
    invalidate()
  }, [materials, color, invalidate])
}

/** Names the theme a 3D view shows on its canvas (`data-theme`), for tests. */
export function useThemeName(name: string) {
  const canvas = useThree((s) => s.gl.domElement)
  useEffect(() => canvas.setAttribute('data-theme', name), [canvas, name])
}
