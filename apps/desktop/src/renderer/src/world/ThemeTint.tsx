import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect } from 'react'
import type * as THREE from 'three'
import { useViewTheme } from './useThemeLook'

/**
 * Tints terrain materials by the theme in force at the playhead (their
 * colours are multiplied by it), drawing a frame when it changes. On its own,
 * so the view around it doesn't re-render as the playhead moves.
 */
export function LandTint({ worldId, regionIds, materials }: { worldId: string; regionIds?: readonly string[]; materials: readonly THREE.MeshStandardMaterial[] }) {
  const { land } = useViewTheme(worldId, regionIds)
  const invalidate = useThree((s) => s.invalidate)
  useLayoutEffect(() => {
    for (const m of materials) m.color.set(land)
    invalidate()
  }, [materials, land, invalidate])
  return null
}

/** Names the theme a 3D view shows on its canvas (`data-theme`), for tests. */
export function useThemeName(name: string) {
  const canvas = useThree((s) => s.gl.domElement)
  useEffect(() => canvas.setAttribute('data-theme', name), [canvas, name])
}
