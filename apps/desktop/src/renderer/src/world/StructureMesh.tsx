import type { Blueprint, BlueprintModel, BlueprintPart, Material, Shape } from '@universe/core'
import { useThree } from '@react-three/fiber'
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
const WEATHERING_KEY = () => 'weathering-v1'

/**
 * A blueprint's parts in metres, aged to `condition`: colours fade toward
 * grime, fragile parts fall away, and ruins slump. `ghost` draws it faintly
 * (destroyed, or not built yet, but selected).
 */
export function BlueprintParts({
  blueprint,
  condition = 100,
  materials,
  ghost = false
}: {
  blueprint: Blueprint
  condition?: number
  /** Each material's own condition, when known: parts then fall material by material. */
  materials?: Partial<Record<Material, number>>
  ghost?: boolean
}) {
  if (blueprint.model) return <ModelMesh model={blueprint.model} condition={condition} ghost={ghost} />
  return <PrimitiveParts blueprint={blueprint} condition={condition} materials={materials} ghost={ghost} />
}

function PrimitiveParts({ blueprint, condition, materials, ghost }: { blueprint: Blueprint; condition: number; materials?: Partial<Record<Material, number>>; ghost: boolean }) {
  // Material conditions change continuously; parts only fall at whole points.
  const key = materials && Object.values(materials).map((c) => Math.floor(c!)).join()
  const whole = Math.floor(condition)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` and `whole` stand for `materials` and `condition`
  const parts = useMemo(() => (ghost ? blueprint.parts : standingParts(blueprint.parts, condition, materials)), [blueprint.parts, whole, key, ghost])
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
  // In steps of 1%, so scrubbing the playhead doesn't recolour every part on every frame.
  const age = ghost ? 0 : Math.round(Math.min(0.65, (1 - condition / 100) * 0.8) * 100) / 100
  return (
    <group scale={[1, slump, 1]}>
      {groups.map((list) => (
        <PartInstances key={`${list[0]!.shape}|${list[0]!.color}|${list.length}`} parts={list} age={age} ghost={ghost} />
      ))}
    </group>
  )
}

const UP = new THREE.Vector3(0, 1, 0)

/**
 * Weathering in the shader (PLAN.md §4.7): with age, moss gathers on the
 * faces that look up, and grime streaks the walls, mottled so no two stones
 * look the same. `uAge` is 0 (new) to about 0.65 (a ruin).
 */
function weathering(this: THREE.Material, shader: THREE.WebGLProgramParametersWithUniforms) {
  // The uniform lives on the material, so ageing only changes a number.
  shader.uniforms.uAge = this.userData.uAge ??= { value: 0 }
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vUp;\nvarying vec3 vWorldPos;')
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vUp = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal).y;
        vWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vUp = normalize(mat3(modelMatrix) * objectNormal).y;
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif`
    )
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uAge;\nvarying float vUp;\nvarying vec3 vWorldPos;')
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      float mottle = fract(sin(dot(floor(vWorldPos * 0.8), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      float moss = smoothstep(0.4, 0.95, vUp) * smoothstep(0.08, 0.5, uAge) * (0.55 + 0.45 * mottle);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.31, 0.13), moss * 0.85);
      float grime = uAge * (1.0 - smoothstep(-0.2, 0.6, vUp)) * (0.5 + 0.5 * mottle);
      diffuseColor.rgb *= 1.0 - 0.45 * grime;`
    )
}

/** Sets a weathering material's age. */
function setAge(material: THREE.Material | THREE.Material[], age: number) {
  for (const m of Array.isArray(material) ? material : [material]) (m.userData.uAge ??= { value: 0 }).value = age
}

function PartInstances({ parts, age, ghost }: { parts: BlueprintPart[]; age: number; ghost: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const invalidate = useThree((s) => s.invalidate)
  const { shape, color } = parts[0]!
  const tinted = useMemo(() => new THREE.Color(color).lerp(WEATHERED, age), [color, age])
  useEffect(() => {
    if (mesh.current) setAge(mesh.current.material, age)
    invalidate()
  }, [age, ghost, invalidate])
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
    invalidate()
  }, [parts, invalidate])
  return (
    <instancedMesh ref={mesh} args={[GEOMETRIES[shape], undefined, parts.length]}>
      <meshStandardMaterial
        color={tinted}
        roughness={0.85}
        transparent={ghost}
        opacity={ghost ? 0.25 : 1}
        depthWrite={!ghost}
        onBeforeCompile={weathering}
        customProgramCacheKey={WEATHERING_KEY}
      />
    </instancedMesh>
  )
}

/** An imported model at its real height, tinted toward grime as it ages and slumping as a ruin. */
function ModelMesh({ model, condition, ghost }: { model: BlueprintModel; condition: number; ghost: boolean }) {
  const object = useModel(model.assetId)
  const invalidate = useThree((s) => s.invalidate)
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
    invalidate()
  }, [object, age, ghost, invalidate])
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

