import { noRaycast } from './pick'

/** How strongly a thing the selected event would hit is ringed: fainter for a glancing blow (`hit` 0–1). */
export const hitOpacity = (hit = 0) => 0.35 + 0.6 * hit

/**
 * The ring under a selected thing (white), or under one the selected event
 * would hit (red, stronger the harder it's hit): flat on the ground, `lift`
 * above it, drawn over everything. Nothing when neither.
 */
export function SelectionRing({
  inner,
  outer,
  segments = 32,
  lift,
  selected,
  hit,
  solid = false
}: {
  inner: number
  outer: number
  segments?: number
  lift: number
  selected: boolean
  hit?: number
  /** Opaque rather than a little see-through. */
  solid?: boolean
}) {
  if (!selected && hit === undefined) return null
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, lift, 0]} raycast={noRaycast}>
      <ringGeometry args={[inner, outer, segments]} />
      <meshBasicMaterial color={selected ? '#ffffff' : '#ff5a5a'} transparent={!solid} opacity={solid ? 1 : selected ? 0.9 : hitOpacity(hit)} depthTest={false} />
    </mesh>
  )
}
