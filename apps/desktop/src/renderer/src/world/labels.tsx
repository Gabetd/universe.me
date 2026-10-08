import { useFrame } from '@react-three/fiber'
import { useMemo } from 'react'
import * as THREE from 'three'

/** Text shown next to a point in a 3D view. */
export interface ViewLabel {
  key: string
  text: string
  selected: boolean
  /** Where it points, in the scene; null hides it (e.g. on the far side of the planet). */
  at(camera: THREE.Camera): [number, number, number] | null
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

/** Moves each HTML label to its point on screen every frame. */
export function LabelProjector({ items, labels }: { items: ViewLabel[]; labels: Map<string, HTMLDivElement> }) {
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ camera, size }) => {
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
  })
  return null
}
