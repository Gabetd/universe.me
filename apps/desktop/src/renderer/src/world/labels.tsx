import { useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { PlacedCharacter } from './useCharacters'
import type { PlacedStructure } from './useStructures'
import type { EventPin } from './useWorldAtTime'

/** Text shown next to a point in a 3D view. */
export interface ViewLabel {
  key: string
  text: string
  selected: boolean
  /** Where it points, in the scene; null hides it (e.g. on the far side of the planet). */
  at(camera: THREE.Camera): [number, number, number] | null
}

/** Which things the surface views name: structures that show their name (or are selected), every character, and events happening at the playhead (or selected). */
export const showsLabel = {
  structure: (s: PlacedStructure) => (s.structure.label && s.state.exists) || s.selected,
  pin: (p: EventPin) => p.active || p.selected
}

/** Where a 3D view puts the label of each kind of thing. */
interface Anchors {
  structure(s: PlacedStructure): ViewLabel['at']
  character(c: PlacedCharacter): ViewLabel['at']
  pin(p: EventPin): ViewLabel['at']
}

/** The labels a 3D view shows (see `showsLabel`), each where `anchors` puts it. */
export function viewLabels(structures: PlacedStructure[], characters: PlacedCharacter[], pins: EventPin[], anchors: Anchors): ViewLabel[] {
  return [
    ...structures.flatMap((s) => (showsLabel.structure(s) ? [{ key: `structure:${s.structure.id}`, text: s.state.name, selected: s.selected, at: anchors.structure(s) }] : [])),
    ...characters.map((c) => ({ key: `character:${c.character.id}`, text: c.character.name, selected: c.selected, at: anchors.character(c) })),
    ...pins.flatMap((p, i) => (showsLabel.pin(p) ? [{ key: `pin:${p.eventId}:${i}`, text: p.title, selected: p.selected, at: anchors.pin(p) }] : []))
  ]
}

/** HTML labels over a view's canvas; `LabelProjector` (inside the canvas) keeps them on their points. */
export function LabelLayer({ items, labels }: { items: ViewLabel[]; labels: Map<string, HTMLDivElement> }) {
  return (
    <div className="pin-labels" aria-hidden>
      {items.map((l) => (
        <div key={l.key} ref={(el) => void (el ? labels.set(l.key, el) : labels.delete(l.key))} className={`pin-label${l.selected ? ' selected' : ''}`}>
          {l.text}
        </div>
      ))}
    </div>
  )
}

/** Moves each HTML label to its point on screen: every frame, and when the labels change (which needs no frame). */
export function LabelProjector({ items, labels }: { items: ViewLabel[]; labels: Map<string, HTMLDivElement> }) {
  const v = useMemo(() => new THREE.Vector3(), [])
  const get = useThree((s) => s.get)
  const project = useCallback(
    ({ camera, size }: { camera: THREE.Camera; size: { width: number; height: number } }) => {
      for (const l of items) {
        const el = labels.get(l.key)
        if (!el) continue
        const at = l.at(camera)
        if (at) v.set(...at).project(camera)
        // Behind the camera counts as hidden too.
        const shown = !!at && v.z < 1
        el.style.display = shown ? '' : 'none'
        if (shown) el.style.transform = `translate(${((v.x + 1) / 2) * size.width + 10}px, ${((1 - v.y) / 2) * size.height - 9}px)`
      }
    },
    [items, labels, v]
  )
  useEffect(() => project(get()), [project, get])
  useFrame(project)
  return null
}
