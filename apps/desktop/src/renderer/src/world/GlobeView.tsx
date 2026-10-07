import { CUBE_FACES, TERRAIN_RES } from '@universe/core'
import { faceToDir, latLonToDir, renderFaceTexture, type TerrainModel, type Vec3 } from '@universe/procgen'
import { Line, OrbitControls, Stars } from '@react-three/drei'
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useUi } from '../store'
import { SPACE_BG } from '../theme'
import { isBrushTool, useEditor } from './editorStore'
import type { SurfaceViewProps } from './useTerrain'

/** Vertices per face edge. Heights are sampled from the 256² grid, so 128 keeps the mesh light. */
const SEGMENTS = 128

const ALL_FACES = Array.from({ length: CUBE_FACES }, (_, f) => f)

/** Position just above the surface (or the sea) in direction `dir`, in globe units. */
function surfacePoint(model: TerrainModel, dir: Vec3, scale: number, lift: number): [number, number, number] {
  const r = 1 + Math.max(model.sampleHeight(...dir), model.settings.seaLevel) * scale + lift
  return [dir[0] * r, dir[1] * r, dir[2] * r]
}

export function GlobeView(props: SurfaceViewProps) {
  const tool = useEditor((s) => s.tool)
  return (
    <Canvas camera={{ position: [0, 0.6, 3], fov: 45, near: 0.01, far: 200 }} data-testid="globe" gl={{ preserveDrawingBuffer: true }}>
      <color attach="background" args={[SPACE_BG]} />
      <ambientLight intensity={0.45} />
      <directionalLight position={[4, 2, 3]} intensity={2.2} />
      <Stars radius={80} depth={40} count={4000} factor={3} fade speed={0} />
      <Planet {...props} />
      <OrbitControls
        enablePan={false}
        minDistance={1.15}
        maxDistance={8}
        rotateSpeed={0.5}
        zoomSpeed={0.8}
        // With a tool selected, left-drag edits and right-drag rotates.
        mouseButtons={{ LEFT: tool === 'navigate' ? THREE.MOUSE.ROTATE : (-1 as THREE.MOUSE), MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }}
      />
    </Canvas>
  )
}

function Planet({ model, change, regions, onPointerDown, onPointerMove, onDoubleClick }: SurfaceViewProps) {
  const exaggeration = useEditor((s) => s.exaggeration)
  const faces = useMemo(() => ALL_FACES.map(createFace), [])
  const cursor = useRef<THREE.Mesh>(null)
  const hover = useRef<Vec3 | null>(null)
  const radiusM = model.settings.radiusKm * 1000
  const scale = exaggeration / radiusM
  const seaRadius = 1 + model.settings.seaLevel * scale

  // Recolor only the faces that changed.
  useEffect(() => {
    for (const f of change.faces === 'all' ? ALL_FACES : change.faces) updateTexture(faces[f]!, model)
  }, [change, faces, model])

  // Reshape the changed faces, or all of them when the relief scale changed (colors don't depend on it).
  const shapedScale = useRef<number>(undefined)
  useEffect(() => {
    const list = scale !== shapedScale.current || change.faces === 'all' ? ALL_FACES : change.faces
    shapedScale.current = scale
    for (const f of list) updateGeometry(faces[f]!, model, scale)
  }, [change, faces, model, scale])

  useEffect(() => () => faces.forEach((f) => (f.geometry.dispose(), f.texture.dispose())), [faces])

  useFrame(() => {
    const c = cursor.current
    if (!c) return
    const { tool, radiusKm } = useEditor.getState()
    const dir = hover.current
    c.visible = !!dir && (isBrushTool(tool) || tool === 'region')
    if (!dir) return
    c.position.set(...surfacePoint(model, dir, scale, 0.002))
    c.lookAt(c.position.x * 2, c.position.y * 2, c.position.z * 2)
    const size = tool === 'region' ? 0.006 : model.angularRadius(radiusKm)
    c.scale.setScalar(size)
  })

  const toDir = (e: ThreeEvent<PointerEvent | MouseEvent>): Vec3 => {
    const p = e.point.clone().normalize()
    return [p.x, p.y, p.z]
  }

  return (
    <group>
      {faces.map((f) => (
        <mesh
          key={f.index}
          geometry={f.geometry}
          onPointerDown={(e) => {
            if (e.button === 0 && onPointerDown(toDir(e))) e.stopPropagation()
          }}
          onPointerMove={(e) => {
            hover.current = toDir(e)
            onPointerMove(hover.current)
          }}
          onPointerOut={() => (hover.current = null)}
          onDoubleClick={onDoubleClick}
        >
          <meshStandardMaterial map={f.texture} roughness={0.95} metalness={0} />
        </mesh>
      ))}
      <mesh scale={seaRadius} raycast={() => null}>
        <sphereGeometry args={[1, 96, 64]} />
        <meshStandardMaterial color="#2b6aa8" transparent opacity={0.35} roughness={0.25} metalness={0.1} depthWrite={false} />
      </mesh>
      <mesh scale={1.06} raycast={() => null}>
        <sphereGeometry args={[1, 64, 32]} />
        <meshBasicMaterial color="#4f8cff" transparent opacity={0.16} side={THREE.BackSide} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh ref={cursor} visible={false} raycast={() => null}>
        <ringGeometry args={[0.92, 1, 48]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.85} depthTest={false} />
      </mesh>
      <RegionLines model={model} change={change} regions={regions} scale={scale} />
    </group>
  )
}

function RegionLines({ model, change, regions, scale }: Pick<SurfaceViewProps, 'model' | 'change' | 'regions'> & { scale: number }) {
  const selectedId = useUi((s) => s.selectedRegionId)
  const draft = useEditor((s) => s.draft)
  // Outlines follow the terrain once a stroke is done, not on every dab of it.
  const settled = model.isStroking ? 'stroking' : change
  const outlines = useMemo(
    () => regions.map((r) => ({ region: r, points: arcPoints([...r.points, r.points[0]!]).map((d) => surfacePoint(model, d, scale, 0.003)) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `settled` stands in for the terrain heights
    [regions, model, scale, settled]
  )
  return (
    <>
      {outlines.map(({ region, points }) => (
        <Line key={region.id} points={points} color={region.color} lineWidth={region.id === selectedId ? 4 : 2} />
      ))}
      {draft.length > 0 && (
        <Line points={arcPoints(draft).map((d) => surfacePoint(model, d, scale, 0.003))} color="#ffffff" lineWidth={2} dashed dashSize={0.01} gapSize={0.006} />
      )}
    </>
  )
}

/** Points along great-circle arcs through `points`, about one per degree, so lines hug the sphere. */
function arcPoints(points: { lat: number; lon: number }[]): Vec3[] {
  const out: Vec3[] = []
  const dirs = points.map((p) => new THREE.Vector3(...latLonToDir(p.lat, p.lon)))
  if (dirs.length === 1) return [dirs[0]!.toArray()]
  for (let i = 0; i < dirs.length - 1; i++) {
    const a = dirs[i]!
    const b = dirs[i + 1]!
    const steps = Math.max(1, Math.ceil((a.angleTo(b) * 180) / Math.PI))
    for (let s = 0; s < steps; s++) out.push(slerp(a, b, s / steps))
  }
  out.push(dirs[dirs.length - 1]!.toArray())
  return out
}

function slerp(a: THREE.Vector3, b: THREE.Vector3, t: number): Vec3 {
  const angle = a.angleTo(b)
  if (angle < 1e-6) return a.toArray()
  const s = Math.sin(angle)
  const v = a.clone().multiplyScalar(Math.sin((1 - t) * angle) / s).add(b.clone().multiplyScalar(Math.sin(t * angle) / s))
  return v.toArray()
}

interface Face {
  index: number
  geometry: THREE.BufferGeometry
  texture: THREE.DataTexture
  pixels: Uint8Array
  /** Unit direction of each vertex, computed once. */
  dirs: Float32Array
}

function createFace(index: number): Face {
  const n = SEGMENTS + 1
  const dirs = new Float32Array(n * n * 3)
  const uvs = new Float32Array(n * n * 2)
  const dir: Vec3 = [0, 0, 0]
  for (let b = 0; b < n; b++) {
    for (let a = 0; a < n; a++) {
      const k = b * n + a
      faceToDir(index, (a / SEGMENTS) * 2 - 1, (b / SEGMENTS) * 2 - 1, dir)
      dirs.set(dir, k * 3)
      uvs[k * 2] = a / SEGMENTS
      uvs[k * 2 + 1] = b / SEGMENTS
    }
  }
  // Wind triangles so they face outward, whichever way this face's axes run.
  const p = (a: number, b: number) => new THREE.Vector3(...dirs.subarray((b * n + a) * 3, (b * n + a) * 3 + 3))
  const outward = new THREE.Vector3().crossVectors(p(1, 0).sub(p(0, 0)), p(0, 1).sub(p(0, 0))).dot(p(0, 0)) > 0
  const indices: number[] = []
  for (let b = 0; b < SEGMENTS; b++) {
    for (let a = 0; a < SEGMENTS; a++) {
      const v00 = b * n + a
      const v10 = v00 + 1
      const v01 = v00 + n
      const v11 = v01 + 1
      if (outward) indices.push(v00, v10, v11, v00, v11, v01)
      else indices.push(v00, v11, v10, v00, v01, v11)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(dirs.slice(), 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  const pixels = new Uint8Array(TERRAIN_RES * TERRAIN_RES * 4)
  const texture = new THREE.DataTexture(pixels, TERRAIN_RES, TERRAIN_RES, THREE.RGBAFormat)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  return { index, geometry, texture, pixels, dirs }
}

function updateGeometry(face: Face, model: TerrainModel, scale: number): void {
  const pos = face.geometry.getAttribute('position') as THREE.BufferAttribute
  const arr = pos.array as Float32Array
  const d = face.dirs
  for (let k = 0; k < d.length; k += 3) {
    // Sampling by direction (not by face) makes shared edge vertices identical, so faces meet without cracks.
    const r = 1 + model.sampleHeight(d[k]!, d[k + 1]!, d[k + 2]!) * scale
    arr[k] = d[k]! * r
    arr[k + 1] = d[k + 1]! * r
    arr[k + 2] = d[k + 2]! * r
  }
  pos.needsUpdate = true
  face.geometry.computeVertexNormals()
  face.geometry.computeBoundingSphere()
}

function updateTexture(face: Face, model: TerrainModel): void {
  renderFaceTexture(model, face.index, face.pixels)
  face.texture.needsUpdate = true
}
