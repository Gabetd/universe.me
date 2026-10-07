import type { Blueprint, BlueprintModel, BlueprintPart, Shape } from '@universe/core'
import { useEffect, useMemo } from 'react'
import { useModel } from './models'
import * as THREE from 'three'
import { standingParts } from './structureLook'

/** Unit geometries with their base at y = 0, scaled per part. */
const GEOMETRIES: Record<Shape, THREE.BufferGeometry> = {
  box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 20).translate(0, 0.5, 0),
  cone: new THREE.ConeGeometry(0.5, 1, 20).translate(0, 0.5, 0),
  // A four-sided cone turned 45° has a unit square base.
  pyramid: new THREE.ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4).translate(0, 0.5, 0),
  sphere: new THREE.SphereGeometry(0.5, 20, 14).translate(0, 0.5, 0)
}

const WEATHERED = new THREE.Color('#6b6455')

/**
 * A blueprint's parts in metres, aged to `condition`: colours fade toward
 * grime, fragile parts fall away, and ruins slump. `ghost` draws it faintly
 * (destroyed, or not built yet, but selected).
 */
export function BlueprintParts({ blueprint, condition = 100, ghost = false }: { blueprint: Blueprint; condition?: number; ghost?: boolean }) {
  if (blueprint.model) return <ModelMesh model={blueprint.model} condition={condition} ghost={ghost} />
  return <PrimitiveParts blueprint={blueprint} condition={condition} ghost={ghost} />
}

function PrimitiveParts({ blueprint, condition, ghost }: { blueprint: Blueprint; condition: number; ghost: boolean }) {
  const parts = ghost ? blueprint.parts : standingParts(blueprint.parts, condition)
  // Ruins and remnants are lower than the building was.
  const slump = condition < 20 && !ghost ? 0.45 + 0.55 * (condition / 20) : 1
  const age = ghost ? 0 : Math.min(0.65, (1 - condition / 100) * 0.8)
  return (
    <group scale={[1, slump, 1]}>
      {parts.map((p, i) => (
        <PartMesh key={i} part={p} age={age} ghost={ghost} />
      ))}
    </group>
  )
}

/** An imported model at its real height, tinted toward grime as it ages and slumping as a ruin. */
function ModelMesh({ model, condition, ghost }: { model: BlueprintModel; condition: number; ghost: boolean }) {
  const object = useModel(model.assetId)
  const age = ghost ? 0 : Math.min(0.65, (1 - condition / 100) * 0.8)
  useEffect(() => {
    object?.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      for (const m of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]) {
        m.userData.baseColor ??= m.color?.clone()
        if (m.color && m.userData.baseColor) m.color.copy(m.userData.baseColor).lerp(WEATHERED, age)
        m.transparent = ghost
        m.opacity = ghost ? 0.25 : 1
      }
    })
  }, [object, age, ghost])
  const slump = condition < 20 && !ghost ? 0.45 + 0.55 * (condition / 20) : 1
  if (!object) {
    // A placeholder block until the model loads.
    return (
      <mesh geometry={GEOMETRIES.box} scale={[model.heightM * 0.5, model.heightM, model.heightM * 0.5]}>
        <meshStandardMaterial color="#666" transparent opacity={0.4} />
      </mesh>
    )
  }
  return (
    <group scale={[model.heightM, model.heightM * slump, model.heightM]}>
      <primitive object={object} />
    </group>
  )
}

function PartMesh({ part, age, ghost }: { part: BlueprintPart; age: number; ghost: boolean }) {
  const color = useMemo(() => new THREE.Color(part.color).lerp(WEATHERED, age), [part.color, age])
  return (
    <mesh geometry={GEOMETRIES[part.shape]} position={part.at} rotation={[0, (part.rotation * Math.PI) / 180, 0]} scale={part.size}>
      <meshStandardMaterial color={color} roughness={0.85} transparent={ghost} opacity={ghost ? 0.25 : 1} depthWrite={!ghost} />
    </mesh>
  )
}
