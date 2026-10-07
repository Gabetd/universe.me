import type { Blueprint, BlueprintModel, BlueprintPart, Shape } from '@universe/core'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
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
  sphere: new THREE.SphereGeometry(0.5, 20, 14).translate(0, 0.5, 0),
  // A gable roof: a triangle across x, its ridge running along z.
  wedge: new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-0.5, 0), new THREE.Vector2(0.5, 0), new THREE.Vector2(0, 1)]), { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5)
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
  const parts = useMemo(() => (ghost ? blueprint.parts : standingParts(blueprint.parts, condition)), [blueprint.parts, condition, ghost])
  // Parts of the same shape and colour are drawn as one instanced mesh, so a city of thousands of parts stays fast.
  const groups = useMemo(() => {
    const byLook = new Map<string, BlueprintPart[]>()
    for (const p of parts) {
      const key = `${p.shape}|${p.color}`
      byLook.set(key, [...(byLook.get(key) ?? []), p])
    }
    return [...byLook.values()]
  }, [parts])
  // Ruins and remnants are lower than the building was.
  const slump = condition < 20 && !ghost ? 0.45 + 0.55 * (condition / 20) : 1
  const age = ghost ? 0 : Math.min(0.65, (1 - condition / 100) * 0.8)
  return (
    <group scale={[1, slump, 1]}>
      {groups.map((list) => (
        <PartInstances key={`${list[0]!.shape}|${list[0]!.color}|${list.length}`} parts={list} age={age} ghost={ghost} />
      ))}
    </group>
  )
}

const UP = new THREE.Vector3(0, 1, 0)

function PartInstances({ parts, age, ghost }: { parts: BlueprintPart[]; age: number; ghost: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const { shape, color } = parts[0]!
  const tinted = useMemo(() => new THREE.Color(color).lerp(WEATHERED, age), [color, age])
  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    const matrix = new THREE.Matrix4()
    const rotation = new THREE.Quaternion()
    parts.forEach((p, i) => {
      rotation.setFromAxisAngle(UP, (p.rotation * Math.PI) / 180)
      m.setMatrixAt(i, matrix.compose(new THREE.Vector3(...p.at), rotation, new THREE.Vector3(...p.size)))
    })
    m.instanceMatrix.needsUpdate = true
    // Clicks and culling use the bounds of all instances.
    m.computeBoundingSphere()
  }, [parts])
  return (
    <instancedMesh ref={mesh} args={[GEOMETRIES[shape], undefined, parts.length]}>
      <meshStandardMaterial color={tinted} roughness={0.85} transparent={ghost} opacity={ghost ? 0.25 : 1} depthWrite={!ghost} />
    </instancedMesh>
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

