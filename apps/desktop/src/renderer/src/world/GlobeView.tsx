import { CUBE_FACES, TERRAIN_RES, type LatLon } from '@universe/core'
import { dirToLatLon, faceToDir, latLonToDir, renderFaceTexture, type TerrainModel, type Vec3 } from '@universe/procgen'
import { Line, Stars } from '@react-three/drei'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { memo, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useUi } from '../store'
import { SPACE_BG } from '../theme'
import { isBrushTool, useEditor, type EditorTool } from './editorStore'
import { pickWith } from './pick'
import type { SurfaceViewProps, TerrainChange } from './useTerrain'
import { STAGE_COLORS } from './structureLook'
import { EdgePush, zoomOut } from '../components/zoom'
import { viewLabels, type ViewLabel } from './labels'
import { SurfaceCanvas, useReadyWhenDrawn } from './SurfaceCanvas'
import type { PlacedCharacter } from './useCharacters'
import type { PlacedStructure } from './useStructures'
import type { EventPin } from './useWorldAtTime'

/** Labels just above the surface, hidden on the far side of the planet. */
function surfaceLabels(pins: EventPin[], structures: PlacedStructure[], characters: PlacedCharacter[], model: TerrainModel, scale: number): ViewLabel[] {
  const at = (place: LatLon) => {
    const p = new THREE.Vector3(...surfacePoint(model, latLonToDir(place.lat, place.lon), scale, 0.006))
    return (camera: THREE.Camera): [number, number, number] | null => (p.dot(camera.position) > p.lengthSq() ? p.toArray() : null)
  }
  return viewLabels(structures, characters, pins, { structure: (s) => at(s.structure), character: (c) => at(c.place), pin: at })
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

/** The planet from orbit. Memoized, like the other views: the world editor re-renders for things they don't show. */
export const GlobeView = memo(function GlobeView(props: SurfaceViewProps) {
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
})

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
  const { faces } = surfaceOf(model)
  /** The change this view last brought the faces up to. */
  const seen = useRef<{ colored?: TerrainChange; shaped?: TerrainChange }>({})
  const cursor = useRef<THREE.Mesh>(null)
  const hover = useRef<Vec3 | null>(null)
  const radiusM = model.settings.radiusKm * 1000
  const scale = exaggeration / radiusM
  const seaRadius = 1 + model.settings.seaLevel * scale
  // Where each thing stands, worked out again only when they move or the terrain does.
  const placed = useMemo(() => {
    const at = (p: LatLon, lift: number) => surfacePoint(model, latLonToDir(p.lat, p.lon), scale, lift)
    return { pins: pins.map((p) => at(p, 0.006)), structures: structures.map((p) => at(p.structure, 0)), characters: characters.map((c) => at(c.place, 0)) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `change` stands for the terrain heights
  }, [pins, structures, characters, model, scale, change])

  useEffect(() => {
    if (colorFaces(model, change, seen.current.colored)) invalidate()
    seen.current.colored = change
  }, [change, model, invalidate])

  useEffect(() => {
    if (shapeFaces(model, change, scale, seen.current.shaped)) invalidate()
    seen.current.shaped = change
  }, [change, model, scale, invalidate])

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
        <Pin key={`${p.eventId}:${i}`} pin={p} position={placed.pins[i]!} onClick={onPinClick} />
      ))}
      {structures.map((p, i) => (
        <SurfacePin
          key={p.structure.id}
          id={p.structure.id}
          at={placed.structures[i]!}
          color={STAGE_COLORS[p.state.stage]}
          faded={!p.state.exists}
          selected={p.selected}
          hit={p.hit}
          onClick={onStructureClick}
        />
      ))}
      {characters.map((c, i) => (
        <SurfacePin key={c.character.id} id={c.character.id} at={placed.characters[i]!} color={c.character.color} figure selected={c.selected} onClick={onCharacterClick} />
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
  id,
  at,
  color,
  faded = false,
  selected,
  hit,
  figure = false,
  onClick
}: {
  id: string
  at: [number, number, number]
  color: string
  faded?: boolean
  selected: boolean
  hit?: number
  figure?: boolean
  onClick(id: string): void
}) {
  const group = useRef<THREE.Group>(null)
  const [x, y, z] = at
  const quaternion = useMemo(() => new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(x, y, z).normalize()), [x, y, z])
  useFrame(({ camera }) => {
    const distance = camera.position.distanceTo(group.current!.position)
    group.current?.scale.setScalar(distance * (selected ? 0.0042 : 0.0032))
  })
  return (
    <group
      ref={group}
      position={at}
      quaternion={quaternion}
      onPointerDown={pickWith(() => onClick(id))}
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

/** The faces' vertex grid: `SEGMENTS` + 1 vertices along each edge, few enough for 16-bit indices. */
const GRID = SEGMENTS + 1

/** What every planet's faces share: each face's unit vertex directions, the texture coordinates and the triangles. */
let grids: { dirs: Float32Array[]; index: THREE.BufferAttribute[]; uv: THREE.BufferAttribute } | undefined

function faceGrids() {
  if (grids) return grids
  const uvs = new Float32Array(GRID * GRID * 2)
  for (let b = 0; b < GRID; b++) {
    for (let a = 0; a < GRID; a++) {
      uvs[(b * GRID + a) * 2] = a / SEGMENTS
      uvs[(b * GRID + a) * 2 + 1] = b / SEGMENTS
    }
  }
  // Wound to face outward on faces whose axes run one way, or the other: every face uses one of the two.
  const triangles = (outward: boolean) => {
    const indices = new Uint16Array(SEGMENTS * SEGMENTS * 6)
    let i = 0
    for (let b = 0; b < SEGMENTS; b++) {
      for (let a = 0; a < SEGMENTS; a++) {
        const v00 = b * GRID + a
        const v10 = v00 + 1
        const v01 = v00 + GRID
        const v11 = v01 + 1
        indices.set(outward ? [v00, v10, v11, v00, v11, v01] : [v00, v11, v10, v00, v01, v11], i)
        i += 6
      }
    }
    return new THREE.BufferAttribute(indices, 1)
  }
  const windings = [triangles(false), triangles(true)]
  const dirs = ALL_FACES.map((f) => {
    const out = new Float32Array(GRID * GRID * 3)
    const dir: Vec3 = [0, 0, 0]
    for (let b = 0; b < GRID; b++) {
      for (let a = 0; a < GRID; a++) {
        faceToDir(f, (a / SEGMENTS) * 2 - 1, (b / SEGMENTS) * 2 - 1, dir)
        out.set(dir, (b * GRID + a) * 3)
      }
    }
    return out
  })
  const index = dirs.map((d) => {
    const p = (a: number, b: number) => new THREE.Vector3().fromArray(d, (b * GRID + a) * 3)
    return windings[new THREE.Vector3().crossVectors(p(1, 0).sub(p(0, 0)), p(0, 1).sub(p(0, 0))).dot(p(0, 0)) > 0 ? 1 : 0]!
  })
  return (grids = { dirs, index, uv: new THREE.BufferAttribute(uvs, 2) })
}

interface Face {
  index: number
  geometry: THREE.BufferGeometry
  texture: THREE.DataTexture
  pixels: Uint8Array
  /** Unit direction of each vertex. */
  dirs: Float32Array
}

/**
 * A planet's faces as last drawn, kept while the planet is (so going back to
 * the globe redraws nothing unless the terrain changed): the change their
 * colors and their shapes (at relief `scale`) were last brought up to.
 */
interface Surface {
  faces: Face[]
  colored?: TerrainChange
  shaped?: TerrainChange
  scale?: number
}

const surfaces = new WeakMap<TerrainModel, Surface>()

function surfaceOf(model: TerrainModel): Surface {
  let surface = surfaces.get(model)
  if (!surface) surfaces.set(model, (surface = { faces: ALL_FACES.map(createFace) }))
  return surface
}

const changedFaces = (change: TerrainChange) => (change.faces === 'all' ? ALL_FACES : change.faces)

/**
 * Recolors a planet's faces up to `change`: just the ones it touched if they
 * show `seen` (the change before it, as the view saw it), else all of them.
 * Returns whether any were redone.
 */
function colorFaces(model: TerrainModel, change: TerrainChange, seen: TerrainChange | undefined): boolean {
  const surface = surfaceOf(model)
  if (surface.colored === change) return false
  for (const f of surface.colored && surface.colored === seen ? changedFaces(change) : ALL_FACES) updateTexture(surface.faces[f]!, model)
  surface.colored = change
  return true
}

/** Reshapes them likewise, or all of them when the relief scale changed (colors don't depend on it). */
function shapeFaces(model: TerrainModel, change: TerrainChange, scale: number, seen: TerrainChange | undefined): boolean {
  const surface = surfaceOf(model)
  if (surface.shaped === change && surface.scale === scale) return false
  const some = surface.shaped && surface.shaped === seen && surface.scale === scale
  for (const f of some ? changedFaces(change) : ALL_FACES) updateGeometry(surface.faces[f]!, model, scale)
  surface.shaped = change
  surface.scale = scale
  return true
}

function createFace(index: number): Face {
  const grid = faceGrids()
  const dirs = grid.dirs[index]!
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(dirs.slice(), 3))
  geometry.setAttribute('uv', grid.uv)
  geometry.setIndex(grid.index[index]!)
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
