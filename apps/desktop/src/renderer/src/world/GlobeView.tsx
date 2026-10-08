import { CUBE_FACES, TERRAIN_RES } from '@universe/core'
import { dirToLatLon, faceToDir, latLonToDir, renderFaceTexture, type TerrainModel, type Vec3 } from '@universe/procgen'
import { Line, Stars } from '@react-three/drei'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useUi } from '../store'
import { SPACE_BG } from '../theme'
import { isBrushTool, useEditor, type EditorTool } from './editorStore'
import { pickWith } from './pick'
import type { SurfaceViewProps } from './useTerrain'
import { STAGE_COLORS } from './structureLook'
import { EdgePush, zoomOut } from '../components/zoom'
import type { ViewLabel } from './labels'
import { SurfaceCanvas, useReadyWhenDrawn } from './SurfaceCanvas'
import type { PlacedCharacter } from './useCharacters'
import type { PlacedStructure } from './useStructures'
import type { EventPin } from './useWorldAtTime'

/** Labels for active or selected event pins, structures that show their name, and characters. */
function surfaceLabels(pins: EventPin[], structures: PlacedStructure[], characters: PlacedCharacter[], model: TerrainModel, scale: number): ViewLabel[] {
  const at = (lat: number, lon: number) => {
    const p = new THREE.Vector3(...surfacePoint(model, latLonToDir(lat, lon), scale, 0.006))
    // Hidden on the far side of the planet.
    return (camera: THREE.Camera): [number, number, number] | null => (p.dot(camera.position) > p.lengthSq() ? p.toArray() : null)
  }
  return [
    ...pins.flatMap((p, i) => (p.selected || p.active ? [{ key: `pin:${p.eventId}:${i}`, text: p.title, selected: p.selected, at: at(p.lat, p.lon) }] : [])),
    ...structures.flatMap((s) =>
      (s.structure.label && s.state.exists) || s.selected ? [{ key: `structure:${s.structure.id}`, text: s.state.name, selected: s.selected, at: at(s.structure.lat, s.structure.lon) }] : []
    ),
    ...characters.map((c) => ({ key: `character:${c.character.id}`, text: c.character.name, selected: c.selected, at: at(c.place.lat, c.place.lon) }))
  ]
}

/** Vertices per face edge. Heights are sampled from the 256² grid, so 128 keeps the mesh light. */
const SEGMENTS = 128

const ALL_FACES = Array.from({ length: CUBE_FACES }, (_, f) => f)

/** As close as the globe camera gets (in planet radii from the centre); scrolling in further goes down to the ground. */
const MIN_DISTANCE = 1.07
const MAX_DISTANCE = 8

/** Position just above the surface (or the sea) in direction `dir`, in globe units. */
function surfacePoint(model: TerrainModel, dir: Vec3, scale: number, lift: number): [number, number, number] {
  const r = 1 + Math.max(model.sampleHeight(...dir), model.settings.seaLevel) * scale + lift
  return [dir[0] * r, dir[1] * r, dir[2] * r]
}

const CAMERA = { position: [0, 0.6, 3] as [number, number, number], fov: 45, near: 0.01, far: 200 }
const CONTROLS = { enablePan: false, minDistance: MIN_DISTANCE, maxDistance: MAX_DISTANCE, rotateSpeed: 0.5, zoomSpeed: 0.8 }

export function GlobeView(props: SurfaceViewProps) {
  const exaggeration = useEditor((s) => s.exaggeration)
  const scale = exaggeration / (props.model.settings.radiusKm * 1000)
  const items = useMemo(
    () => surfaceLabels(props.pins, props.structures, props.characters, props.model, scale),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `change` stands for the terrain heights
    [props.pins, props.structures, props.characters, props.model, scale, props.change]
  )
  return (
    <SurfaceCanvas testId="globe" camera={CAMERA} navigate={THREE.MOUSE.ROTATE} controls={CONTROLS} labels={items}>
      <color attach="background" args={[SPACE_BG]} />
      <ambientLight intensity={0.45} />
      <directionalLight position={[4, 2, 3]} intensity={2.2} />
      <Stars radius={80} depth={40} count={4000} factor={3} fade speed={0} />
      <Planet {...props} />
      <FocusOn focus={props.focus} />
      <StartOver />
      <ZoomToGround />
    </SurfaceCanvas>
  )
}

function Planet({
  model,
  change,
  regions,
  pins,
  highlightRegionIds,
  onPinClick,
  onPointerDown,
  onPointerMove,
  onDoubleClick,
  structures,
  onStructureClick,
  characters,
  onCharacterClick
}: SurfaceViewProps) {
  const exaggeration = useEditor((s) => s.exaggeration)
  const invalidate = useThree((s) => s.invalidate)
  const faces = useMemo(() => ALL_FACES.map(createFace), [])
  const cursor = useRef<THREE.Mesh>(null)
  const hover = useRef<Vec3 | null>(null)
  const radiusM = model.settings.radiusKm * 1000
  const scale = exaggeration / radiusM
  const seaRadius = 1 + model.settings.seaLevel * scale

  // Recolor only the faces that changed.
  useEffect(() => {
    for (const f of change.faces === 'all' ? ALL_FACES : change.faces) updateTexture(faces[f]!, model)
    invalidate()
  }, [change, faces, model, invalidate])

  // Reshape the changed faces, or all of them when the relief scale changed (colors don't depend on it).
  const shapedScale = useRef<number>(undefined)
  useEffect(() => {
    const list = scale !== shapedScale.current || change.faces === 'all' ? ALL_FACES : change.faces
    shapedScale.current = scale
    for (const f of list) updateGeometry(faces[f]!, model, scale)
    invalidate()
  }, [change, faces, model, scale, invalidate])

  useEffect(() => () => faces.forEach((f) => (f.geometry.dispose(), f.texture.dispose())), [faces])
  // The terrain is in once the effects above have run.
  useReadyWhenDrawn(true)

  // The brush cursor follows the pointer, the tool and the brush size.
  useEffect(() => useEditor.subscribe((s, prev) => (s.tool !== prev.tool || s.radiusKm !== prev.radiusKm) && invalidate()), [invalidate])
  const moveCursor = (dir: Vec3 | null) => {
    hover.current = dir
    if (showsCursor(useEditor.getState().tool)) invalidate()
  }

  useFrame(() => {
    const c = cursor.current
    if (!c) return
    const { tool, radiusKm } = useEditor.getState()
    const dir = hover.current
    c.visible = !!dir && showsCursor(tool)
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
            const dir = toDir(e)
            moveCursor(dir)
            onPointerMove(dir)
          }}
          onPointerOut={() => moveCursor(null)}
          onDoubleClick={onDoubleClick}
        >
          <meshStandardMaterial map={f.texture} roughness={0.95} metalness={0} />
        </mesh>
      ))}
      <mesh scale={seaRadius} raycast={() => null}>
        <sphereGeometry args={[1, 96, 64]} />
        <meshStandardMaterial color={model.settings.terrain.waterColor} transparent opacity={0.35} roughness={0.25} metalness={0.1} depthWrite={false} />
      </mesh>
      <mesh scale={1.06} raycast={() => null}>
        <sphereGeometry args={[1, 64, 32]} />
        <meshBasicMaterial color="#4f8cff" transparent opacity={0.16} side={THREE.BackSide} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh ref={cursor} visible={false} raycast={() => null}>
        <ringGeometry args={[0.92, 1, 48]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.85} depthTest={false} />
      </mesh>
      <RegionLines model={model} change={change} regions={regions} highlight={highlightRegionIds} scale={scale} />
      {pins.map((p, i) => (
        <Pin key={`${p.eventId}:${i}`} pin={p} position={surfacePoint(model, latLonToDir(p.lat, p.lon), scale, 0.006)} onClick={onPinClick} />
      ))}
      {structures.map((p) => (
        <SurfacePin
          key={p.structure.id}
          at={surfacePoint(model, latLonToDir(p.structure.lat, p.structure.lon), scale, 0)}
          color={STAGE_COLORS[p.state.stage]}
          faded={!p.state.exists}
          selected={p.selected}
          hit={p.hit}
          onClick={() => onStructureClick(p.structure.id)}
        />
      ))}
      {characters.map((c) => (
        <SurfacePin
          key={c.character.id}
          at={surfacePoint(model, latLonToDir(c.place.lat, c.place.lon), scale, 0)}
          color={c.character.color}
          figure
          selected={c.selected}
          onClick={() => onCharacterClick(c.character.id)}
        />
      ))}
    </group>
  )
}

/** Brushes and region drawing show where they'd land under the pointer. */
const showsCursor = (tool: EditorTool) => isBrushTool(tool) || tool === 'region'

function RegionLines({
  model,
  change,
  regions,
  highlight,
  scale
}: Pick<SurfaceViewProps, 'model' | 'change' | 'regions'> & {
  highlight: Set<string>
  scale: number
}) {
  const selectedId = useUi((s) => s.selectedRegionId)
  const draft = useEditor((s) => s.draft)
  // Outlines follow the terrain once a stroke is done, not on every dab of it.
  const settled = model.isStroking ? 'stroking' : change
  const outlines = useMemo(
    () =>
      regions.map((r) => ({
        region: r,
        points: arcPoints([...r.points, r.points[0]!]).map((d) => surfacePoint(model, d, scale, 0.003))
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `settled` stands in for the terrain heights
    [regions, model, scale, settled]
  )
  return (
    <>
      {outlines.map(({ region, points }) => (
        <Line
          key={region.id}
          points={points}
          color={highlight.has(region.id) ? '#ffffff' : region.color}
          lineWidth={region.id === selectedId || highlight.has(region.id) ? 4 : 2}
        />
      ))}
      {draft.length > 0 && (
        <Line points={arcPoints(draft).map((d) => surfacePoint(model, d, scale, 0.003))} color="#ffffff" lineWidth={2} dashed dashSize={0.01} gapSize={0.006} />
      )}
    </>
  )
}

/** An event's location: a dot, brighter while the event is happening at the playhead. */
function Pin({ pin, position, onClick }: { pin: EventPin; position: [number, number, number]; onClick(eventId: string): void }) {
  const size = pin.selected ? 0.014 : pin.active ? 0.01 : 0.007
  return (
    <mesh
      position={position}
      onPointerDown={pickWith(() => onClick(pin.eventId))}
    >
      <sphereGeometry args={[size, 16, 12]} />
      <meshBasicMaterial color={pin.color} transparent opacity={pin.active || pin.selected ? 1 : 0.5} />
    </mesh>
  )
}

const UP = new THREE.Vector3(0, 1, 0)
const PIN_HEAD = new THREE.SphereGeometry(1, 16, 12).translate(0, 3.2, 0)
const PIN_STEM = new THREE.ConeGeometry(0.75, 2.6, 12).rotateX(Math.PI).translate(0, 1.3, 0)
const FIGURE = new THREE.CapsuleGeometry(0.75, 1.6, 4, 12).translate(0, 1.55, 0)

/**
 * A structure or a character on the globe. Buildings are far too small to see
 * from orbit, so each is a pin (a character a little figure) of a constant
 * size on screen; zooming all the way in shows the real thing.
 */
function SurfacePin({
  at,
  color,
  faded = false,
  selected,
  hit,
  figure = false,
  onClick
}: {
  at: [number, number, number]
  color: string
  faded?: boolean
  selected: boolean
  hit?: number
  figure?: boolean
  onClick(): void
}) {
  const group = useRef<THREE.Group>(null)
  const quaternion = useMemo(() => new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(...at).normalize()), [at])
  useFrame(({ camera }) => {
    const distance = camera.position.distanceTo(group.current!.position)
    group.current?.scale.setScalar(distance * (selected ? 0.0042 : 0.0032))
  })
  return (
    <group
      ref={group}
      position={at}
      quaternion={quaternion}
      onPointerDown={pickWith(onClick)}
    >
      {figure ? (
        <mesh geometry={FIGURE}>
          <meshBasicMaterial color={color} />
        </mesh>
      ) : (
        <>
          <mesh geometry={PIN_STEM}>
            <meshBasicMaterial color={selected ? '#ffffff' : '#1a1f2e'} transparent={faded} opacity={faded ? 0.4 : 1} />
          </mesh>
          <mesh geometry={PIN_HEAD}>
            <meshBasicMaterial color={color} transparent={faded} opacity={faded ? 0.4 : 1} />
          </mesh>
        </>
      )}
      {(selected || hit !== undefined) && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} raycast={() => null}>
          <ringGeometry args={[1.6, 2.1, 32]} />
          <meshBasicMaterial color={selected ? '#ffffff' : '#ff5a5a'} transparent opacity={selected ? 0.9 : 0.35 + 0.6 * (hit ?? 0)} depthTest={false} />
        </mesh>
      )}
    </group>
  )
}

/** Opens facing where the view last looked (e.g. coming back up from the ground), and keeps note of it. */
function StartOver() {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as (THREE.EventDispatcher<{ end: object }> & { update(): void }) | null
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const { lookingAt, lookDistance } = useEditor.getState()
    if (lookingAt) camera.position.copy(new THREE.Vector3(...latLonToDir(lookingAt.lat, lookingAt.lon)).multiplyScalar(lookDistance))
    controls?.update()
    invalidate()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the view opens
  }, [controls])
  useEffect(() => {
    if (!controls) return
    const remember = () => {
      const { lat, lon } = dirToLatLon(...(camera.position.clone().normalize().toArray() as Vec3))
      useEditor.getState().set({ lookingAt: { lat, lon }, lookDistance: camera.position.length() })
    }
    controls.addEventListener('end', remember)
    return () => controls.removeEventListener('end', remember)
  }, [controls, camera])
  return null
}

/**
 * Scrolling in past the closest globe view goes down to the ground at the
 * middle of the view; scrolling out past the farthest goes up to the planet
 * in its orbit.
 */
function ZoomToGround() {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    const edge = new EdgePush()
    const onWheel = (e: WheelEvent) => {
      const distance = camera.position.length()
      const push = e.deltaY < 0 && distance <= MIN_DISTANCE + 0.003 ? -1 : e.deltaY > 0 && distance >= MAX_DISTANCE - 0.01 ? 1 : 0
      if (!edge.push(push)) return
      if (push > 0) return zoomOut(gl.domElement)
      const ground = dirToLatLon(...(camera.position.clone().normalize().toArray() as Vec3))
      useEditor.getState().enterGround(ground)
    }
    gl.domElement.addEventListener('wheel', onWheel, { passive: true })
    return () => gl.domElement.removeEventListener('wheel', onWheel)
  }, [camera, gl])
  return null
}

/** Turns the globe so the selected event's place faces the camera. */
function FocusOn({ focus }: { focus: SurfaceViewProps['focus'] }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as { update(): void } | null
  const invalidate = useThree((s) => s.invalidate)
  const target = useRef<THREE.Vector3 | null>(null)
  const key = focus?.key
  useEffect(() => {
    target.current = focus ? new THREE.Vector3(...latLonToDir(focus.lat, focus.lon)) : null
    invalidate()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new focus point should move the camera
  }, [key])
  useFrame(() => {
    const goal = target.current
    if (!goal) return
    const distance = camera.position.length()
    const next = camera.position.clone().normalize().lerp(goal, 0.15).normalize()
    camera.position.copy(next.multiplyScalar(distance))
    controls?.update()
    if (next.angleTo(goal) < 0.01) target.current = null
    // Another frame: to keep turning, or once there, to draw everything where the camera stopped.
    invalidate()
  })
  return null
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
  const v = a
    .clone()
    .multiplyScalar(Math.sin((1 - t) * angle) / s)
    .add(b.clone().multiplyScalar(Math.sin(t * angle) / s))
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
