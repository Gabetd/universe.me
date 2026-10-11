import { findBlueprint, insidePolygon, type Blueprint, type BlueprintPart, type LatLon } from '@universe/core'
import {
  CHUNK_M,
  CHUNK_SEGMENTS,
  GroundDetail,
  SKIRT_M,
  INSTANCE_STRIDE,
  chunkBounds,
  chunkKey,
  chunkOf,
  chunksAround,
  fromLocal,
  latLonToDir,
  modelSampler,
  toLocal,
  type GroundChunk,
  type LocalFrame,
  type Plant
} from '@universe/procgen'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { EdgePush } from '../components/zoom'
import { useUi } from '../store'
import { useByValue } from '../useByValue'
import { useEditor } from './editorStore'
import { noRaycast, toolPress, usePick, usePickInstances } from './pick'
import { viewLabels, type ViewLabel } from './labels'
import { NEAR_ONLY, instanceTint, plantGeometry } from './plants'
import { WEATHERED_COLOR, blueprintExtent, blueprintMassing, slumpOf, standingParts, weatheringOf } from './structureLook'
import { BlueprintBatch, BlueprintParts } from './StructureMesh'
import { SelectionRing } from './SelectionRing'
import { SurfaceCanvas, useReadyWhenDrawn } from './SurfaceCanvas'
import { useLandTint, useThemeName } from './ThemeTint'
import { useViewTheme } from './useThemeLook'
import { multiply } from './viewTheme'
import { useGroundChunks } from './useGroundChunks'
import { WalkKeys } from './walk'
import type { PlacedCharacter } from './useCharacters'
import type { PlacedStructure } from './useStructures'
import type { EventPin } from './useWorldAtTime'
import type { SurfaceViewProps } from './useTerrain'

const SKY = '#a9cdea'
/** Where the fog starts and where it hides everything, in metres, in the usual air. */
const FOG = [1400, 3400] as const
/** The light from the sky and from the ground under it. */
const HEMISPHERE = ['#dce9f7', '#4a4536'] as const
/** Chunks drawn around the middle of the view in each direction: a 5 × 5 km square. */
const RING = 2
/** Farthest the camera pulls back; scrolling out past it returns to the globe. */
const MAX_DISTANCE = 2600
/** Things farther than this from the middle of the view aren't drawn (the fog has them). */
const DRAW_M = 3800
const RAD = Math.PI / 180
const inView = (x: number, z: number) => Math.hypot(x, z) <= DRAW_M
const smooth = (t: number) => t * t * (3 - 2 * t)
const latLonOf = (p: LatLon): [number, number] => [p.lat, p.lon]

const CAMERA = { position: [0, 400, 600] as [number, number, number], fov: 55, near: 0.5, far: 9000 }
const CONTROLS = { screenSpacePanning: false, minDistance: 3, maxDistance: MAX_DISTANCE, maxPolarAngle: Math.PI * 0.47, zoomSpeed: 0.9 }

/** Heights of the ground anywhere: the globe's terrain plus the seeded detail the chunks have. */
interface Ground {
  frame: LocalFrame
  /** Metres above sea level at a point of the frame. */
  heightAt(x: number, z: number): number
  /** Where something stands there: on the ground, or on the water over it. */
  standAt(x: number, z: number): number
  /** A height of the bare terrain at a point, levelled where a structure stands. */
  level(x: number, z: number, y: number): number
  heightAtLatLon(p: LatLon): number
}

/** Level ground under a structure, blending back into the hills around it. */
interface Pad {
  x: number
  z: number
  r: number
  y: number
}

/**
 * The world up close, in metres: terrain in 1 km chunks with its trees,
 * grass and rocks; structures at their real size; characters on foot. Opened
 * by scrolling all the way in on the globe (or the Ground button); scrolling
 * all the way out goes back up.
 */
export const GroundView = memo(function GroundView(props: SurfaceViewProps & { seed: number }) {
  const start = useEditor((s) => s.ground) ?? { lat: 0, lon: 0 }
  const [origin, setOrigin] = useState<LatLon>(start)
  const [center, setCenter] = useState<LatLon>(start)
  const [loaded, setLoaded] = useState(0)
  const [failed, setFailed] = useState<string>()
  const { model, change, seed } = props
  const radiusKm = model.settings.radiusKm
  // Every structure the world ever has gets level ground, so the ground doesn't change as they come and go.
  const allStructures = useUi((s) => s.timeline.structures)
  const blueprints = useUi((s) => s.timeline.blueprints)
  // By value: renaming a structure (a new list, the same places) keeps the ground as it is.
  const sites = useByValue(
    useMemo(
      () =>
        allStructures.flatMap((st) => {
          const blueprint = st.ownerId === props.worldId ? findBlueprint(blueprints, st.blueprintId) : undefined
          return blueprint ? [{ at: { lat: st.lat, lon: st.lon }, r: blueprintExtent(blueprint) * st.scale * 0.55 }] : []
        }),
      [allStructures, blueprints, props.worldId]
    )
  )
  const ground = useMemo<Ground>(() => {
    const frame = { origin, radiusKm }
    const detail = new GroundDetail(seed, radiusKm)
    const base = modelSampler(model)
    const raw = (x: number, z: number) => detail.elevation(base, ...latLonOf(fromLocal(frame, x, z)))
    const pads: Pad[] = sites.flatMap(({ at, r }) => {
      const [x, z] = toLocal(frame, at)
      if (!inView(x, z)) return []
      // The average height over its footprint: some ground is cut away, some built up.
      const samples = [raw(x, z), ...Array.from({ length: 8 }, (_, k) => raw(x + Math.cos((k * Math.PI) / 4) * r * 0.7, z + Math.sin((k * Math.PI) / 4) * r * 0.7))]
      const y = samples.reduce((a, b) => a + b, 0) / samples.length
      return y > 0.5 ? [{ x, z, r, y }] : []
    })
    const level = (x: number, z: number, y: number) => {
      for (const p of pads) {
        const d = Math.hypot(x - p.x, z - p.z)
        if (d >= p.r * 1.6) continue
        const t = d <= p.r ? 1 : 1 - smooth((d - p.r) / (p.r * 0.6))
        y += (p.y - y) * t
      }
      return y
    }
    const heightAt = (x: number, z: number) => level(x, z, raw(x, z))
    const heightAtLatLon = (p: LatLon) => {
      const [x, z] = toLocal(frame, p)
      return heightAt(x, z)
    }
    return { frame, heightAtLatLon, heightAt, standAt: (x, z) => Math.max(0, heightAt(x, z)), level }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `change` stands for the terrain heights
  }, [origin, radiusKm, seed, model, change, sites])

  const { structures, characters, pins, regions, worldId } = props
  const items = useMemo(() => groundLabels(structures, characters, pins, ground), [structures, characters, pins, ground])
  // The regions the middle of the view lies in: their own themes show here.
  const here = useByValue(useMemo(() => regions.flatMap((r) => (insidePolygon(center, r.points) ? [r.id] : [])), [regions, center]))
  // One material for every chunk's ground (its colours are the chunk's), tinted by the theme in force.
  const land = useMemo(() => [new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 })], [])
  useEffect(() => () => land[0]!.dispose(), [land])

  return (
    <SurfaceCanvas
      testId="ground"
      camera={CAMERA}
      // Dragging moves over the ground like a map; right-drag looks around.
      navigate={THREE.MOUSE.PAN}
      controls={CONTROLS}
      labels={items}
      // How many chunks are in, for tests to wait on.
      wrap={{ 'data-chunks': loaded }}
      overlay={<GroundReadout ground={ground} error={failed} />}
    >
      <GroundLook worldId={worldId} regionIds={here} water={model.settings.terrain.waterColor} land={land} />
      <Rig ground={ground} onRebase={setOrigin} onCenter={setCenter} />
      <WalkKeys />
      <Chunks {...props} ground={ground} center={center} land={land[0]!} onLoaded={setLoaded} onFailed={setFailed} />
      <GroundStructures structures={props.structures} ground={ground} onClick={props.onStructureClick} />
      {props.characters.map((c) => (
        <Figure key={c.character.id} id={c.character.id} at={c.place} color={c.character.color} selected={c.selected} ground={ground} onClick={props.onCharacterClick} />
      ))}
      {props.pins.map((p, i) => (
        <Beacon key={`${p.eventId}:${i}`} id={p.eventId} at={p} color={p.color} lit={p.active || p.selected} ground={ground} onClick={props.onPinClick} />
      ))}
    </SurfaceCanvas>
  )
})

/** Labels over things on the ground, hidden as far out as things are drawn. */
function groundLabels(structures: PlacedStructure[], characters: PlacedCharacter[], pins: EventPin[], ground: Ground): ViewLabel[] {
  const at = (p: LatLon, lift: number) => {
    const [x, z] = toLocal(ground.frame, p)
    const point: [number, number, number] = [x, ground.standAt(x, z) + lift, z]
    const v = new THREE.Vector3(...point)
    return (camera: THREE.Camera) => (camera.position.distanceTo(v) < DRAW_M ? point : null)
  }
  return viewLabels(structures, characters, pins, {
    structure: (s) => at(s.structure, blueprintExtent(s.blueprint) * s.structure.scale * 0.6 + 4),
    character: (c) => at(c.place, 2.4),
    pin: (p) => at(p, 46)
  })
}

/**
 * Keeps the camera above the ground and its target on it, re-centres the
 * frame when the view has moved far from its origin, tells which chunk the
 * middle of the view is in, and goes back up to the globe when scrolled out.
 */
function Rig({ ground, onRebase, onCenter }: { ground: Ground; onRebase(origin: LatLon): void; onCenter(center: LatLon): void }) {
  // Through `get`, so the camera and controls are the scene's to move, not values held by this component.
  const get = useThree((s) => s.get)
  const invalidate = useThree((s) => s.invalidate)
  const hasControls = useThree((s) => !!s.controls)
  const lastChunk = useRef('')
  const rig = () => {
    const { camera, controls, gl } = get()
    return { camera, gl, controls: controls as unknown as { target: THREE.Vector3; update(): void } | null }
  }

  // Start looking down at the origin, from as far as asked.
  useEffect(() => {
    const { camera, controls } = rig()
    if (!controls) return
    const y = ground.standAt(0, 0)
    const d = useEditor.getState().groundDistance
    controls.target.set(0, y, 0)
    camera.position.set(0, y + d * 0.6, d * 0.8)
    controls.update()
    invalidate()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the controls exist
  }, [hasControls])

  useFrame(() => {
    const { camera, controls, gl } = rig()
    if (!controls) return
    const t = controls.target
    t.y = ground.standAt(t.x, t.z)
    // Where the view looks, in metres from the frame's origin (east, south), for tests to read.
    const at = `${Math.round(t.x)},${Math.round(t.z)}`
    if (gl.domElement.dataset.at !== at) gl.domElement.dataset.at = at
    const floor = ground.standAt(camera.position.x, camera.position.z) + 1.7
    if (camera.position.y < floor) camera.position.y = floor
    const here = fromLocal(ground.frame, t.x, t.z)
    const key = chunkKey(chunkOf(here, ground.frame.radiusKm))
    if (key !== lastChunk.current) {
      lastChunk.current = key
      onCenter(here)
    }
    // Far from the origin, the flat frame starts to stretch: start a new one here.
    if (Math.hypot(t.x, t.z) > 2500) {
      camera.position.x -= t.x
      camera.position.z -= t.z
      t.set(0, t.y, 0)
      onRebase(here)
    }
    controls.update()
  })

  useEffect(() => {
    const { gl } = rig()
    const edge = new EdgePush()
    const onWheel = (e: WheelEvent) => {
      const { camera, controls } = rig()
      if (!controls) return
      if (edge.push(e.deltaY > 0 && camera.position.distanceTo(controls.target) >= MAX_DISTANCE - 1 ? 1 : 0)) {
        useEditor.getState().leaveGround(fromLocal(ground.frame, controls.target.x, controls.target.z))
      }
    }
    gl.domElement.addEventListener('wheel', onWheel, { passive: true })
    return () => gl.domElement.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `rig` reads the live scene
  }, [ground])
  return null
}

/**
 * The sky, its haze, the light, the sea and the land, as the theme in force
 * at the playhead has them where the view is (a region's own themes in it).
 * On its own, so only it re-renders as themes blend; the sky, fog and lights
 * change in place (a new fog would recompile every material).
 */
function GroundLook({ worldId, regionIds, water, land }: { worldId: string; regionIds: readonly string[]; water: string; land: readonly THREE.MeshStandardMaterial[] }) {
  const theme = useViewTheme(worldId, regionIds)
  useThemeName(theme.name)
  useLandTint(land, theme.land)
  const sky = theme.sky(SKY)
  const background = useMemo(() => new THREE.Color(), [])
  const invalidate = useThree((s) => s.invalidate)
  useLayoutEffect(() => {
    background.set(sky)
    invalidate()
  }, [background, sky, invalidate])
  return (
    <>
      <primitive object={background} attach="background" />
      <fog attach="fog" args={[SKY, ...FOG]} color={sky} near={FOG[0] / theme.haze} far={FOG[1] / theme.haze} />
      <hemisphereLight color={multiply(HEMISPHERE[0], theme.ambient)} groundColor={HEMISPHERE[1]} intensity={0.75 * theme.ambientScale} />
      <directionalLight position={[700, 650, 250]} color={theme.sun} intensity={1.6 * theme.sunScale} />
      <Water color={theme.water(water)} />
    </>
  )
}

/** The sea: a sheet at sea level that follows the view. */
function Water({ color }: { color: string }) {
  const mesh = useRef<THREE.Mesh>(null)
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null
  useFrame(() => {
    if (mesh.current && controls) mesh.current.position.set(controls.target.x, 0, controls.target.z)
  })
  return (
    <mesh ref={mesh} rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast}>
      <planeGeometry args={[DRAW_M * 3, DRAW_M * 3]} />
      <meshStandardMaterial color={color} transparent opacity={0.82} roughness={0.15} metalness={0.1} depthWrite={false} />
    </mesh>
  )
}

/** Where standing structures are, in the frame: plants don't grow through them. */
interface Footprint {
  x: number
  z: number
  r: number
}

function Chunks(
  props: SurfaceViewProps & { seed: number; ground: Ground; center: LatLon; land: THREE.Material; onLoaded(count: number): void; onFailed(error: string | undefined): void }
) {
  const { model, change, seed, ground, center, structures, land, onLoaded, onFailed } = props
  const radiusKm = model.settings.radiusKm
  const wanted = useMemo(() => chunksAround(center, radiusKm, RING), [center, radiusKm])
  const { chunks, error } = useGroundChunks(model, change, seed, wanted)
  useEffect(() => onLoaded(chunks.size), [chunks.size, onLoaded])
  useEffect(() => onFailed(error), [error, onFailed])
  useReadyWhenDrawn(chunks.size === wanted.length)
  const middle = chunkOf(center, radiusKm)
  const vegetationColor = model.settings.terrain.vegetationColor
  const plants = useMemo(() => new PlantGeometries(new THREE.Color(vegetationColor)), [vegetationColor])
  useEffect(() => () => plants.dispose(), [plants])
  // By value, so plants are laid out again only when a footprint changes, not whenever the structures do (renamed, or the playhead moved).
  const footprints = useByValue(
    useMemo<Footprint[]>(
      () =>
        structures.flatMap(({ structure, state, blueprint }) => {
          // Ruins are overgrown; standing buildings keep their ground clear.
          if (!state.exists || state.condition < 20) return []
          const [x, z] = toLocal(ground.frame, structure)
          return [{ x, z, r: blueprintExtent(blueprint) * structure.scale * 0.55 }]
        }),
      [structures, ground.frame]
    )
  )
  return (
    <>
      {wanted.map((id) => {
        const chunk = chunks.get(chunkKey(id))
        if (!chunk) return null
        const ring = Math.max(Math.abs(id.row - middle.row), Math.abs(id.col - middle.col))
        return (
          <ChunkView
            key={chunkKey(id)}
            chunk={chunk}
            ring={ring}
            ground={ground}
            material={land}
            plants={plants}
            footprints={footprints}
            onPointerDown={props.onPointerDown}
            onPointerMove={props.onPointerMove}
          />
        )
      })}
    </>
  )
}

/** One chunk, placed in the view's frame from its own (it was built around its south-west corner). */
const ChunkView = memo(function ChunkView({
  chunk,
  ring,
  ground,
  material,
  plants,
  footprints,
  onPointerDown,
  onPointerMove
}: {
  chunk: GroundChunk
  ring: number
  ground: Ground
  material: THREE.Material
  plants: PlantGeometries
  footprints: Footprint[]
  onPointerDown: SurfaceViewProps['onPointerDown']
  onPointerMove: SurfaceViewProps['onPointerMove']
}) {
  const bounds = chunkBounds(chunk.id, ground.frame.radiusKm)
  const [x, z] = toLocal(ground.frame, { lat: bounds.lat0, lon: bounds.lon0 })
  // East-west, the view's frame and the chunk's own differ by the ratio of their latitudes' cosines.
  const stretch = Math.cos(ground.frame.origin.lat * RAD) / Math.cos(bounds.lat0 * RAD)
  /** Levels a height of the chunk (at chunk coordinates) where structures stand. */
  const level = useCallback((lx: number, lz: number, y: number) => ground.level(x + lx * stretch, z + lz, y), [ground, x, z, stretch])
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const positions = chunk.positions.slice()
    const grid = (CHUNK_SEGMENTS + 1) ** 2
    for (let i = 0; i < positions.length; i += 3) {
      // Skirt vertices hang a few metres under the edge; they move with it.
      const drop = i / 3 >= grid ? SKIRT_M : 0
      positions[i + 1] = level(positions[i]!, positions[i + 2]!, positions[i + 1]! + drop) - drop
    }
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    // The chunk's colours are sRGB, like the map's; the renderer works in linear light.
    const color = new THREE.Color()
    const colors = new Float32Array(chunk.colors.length)
    for (let i = 0; i < colors.length; i += 3) color.setRGB(chunk.colors[i]!, chunk.colors[i + 1]!, chunk.colors[i + 2]!, THREE.SRGBColorSpace).toArray(colors, i)
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.setIndex(new THREE.BufferAttribute(chunk.indices, 1))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    return g
  }, [chunk, level])
  useEffect(() => () => geometry.dispose(), [geometry])
  const local = useMemo(() => footprints.map((f) => ({ x: (f.x - x) / stretch, z: f.z - z, r: f.r })).filter((f) => f.x > -f.r && f.x < CHUNK_M * 1.5 + f.r && f.z < f.r && f.z > -CHUNK_M * 1.5 - f.r), [footprints, x, z, stretch])
  const { frame } = ground
  const handlers = useMemo(() => {
    const dir = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
      const p = fromLocal(frame, e.point.x, e.point.z)
      return latLonToDir(p.lat, p.lon)
    }
    return { down: toolPress(dir, onPointerDown), move: (e: ThreeEvent<PointerEvent>) => onPointerMove(dir(e)) }
  }, [frame, onPointerDown, onPointerMove])
  return (
    <group position={[x, 0, z]} scale={[stretch, 1, 1]}>
      <mesh geometry={geometry} material={material} onPointerDown={handlers.down} onPointerMove={handlers.move} />
      {Object.entries(chunk.plants).map(([plant, list]) =>
        ring > 0 && NEAR_ONLY.includes(plant as Plant) ? null : (
          <PlantInstances key={plant} plant={plant as Plant} list={list} share={RING_SHARE[ring] ?? 0} plants={plants} footprints={local} level={level} />
        )
      )}
    </group>
  )
})

/** How much of a chunk's plants are drawn, by its distance in chunks from the middle of the view: the far ones are thinned. */
const RING_SHARE = [1, 0.55, 0.25]

/** The plants' shapes in the world's foliage colour, made as they're first needed and let go with the colour or the view. */
class PlantGeometries {
  private made = new Map<Plant, THREE.BufferGeometry>()
  constructor(private foliage: THREE.Color) {}

  get(plant: Plant): THREE.BufferGeometry {
    let g = this.made.get(plant)
    if (!g) this.made.set(plant, (g = plantGeometry(plant, this.foliage)))
    return g
  }

  dispose() {
    for (const g of this.made.values()) g.dispose()
  }
}

/** All of one kind of plant on a chunk, as one instanced mesh; `share` draws only that fraction of them (farther chunks). */
function PlantInstances({
  plant,
  list,
  share,
  plants,
  footprints,
  level
}: {
  plant: Plant
  list: Float32Array
  share: number
  plants: PlantGeometries
  footprints: Footprint[]
  level(x: number, z: number, y: number): number
}) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const invalidate = useThree((s) => s.invalidate)
  const kept = useMemo(() => {
    const out: number[] = []
    const total = Math.floor((list.length / INSTANCE_STRIDE) * share)
    for (let i = 0; i < total; i++) {
      const o = i * INSTANCE_STRIDE
      const px = list[o]!
      const pz = list[o + 2]!
      if (!footprints.some((f) => Math.hypot(px - f.x, pz - f.z) < f.r)) out.push(o)
    }
    return out
  }, [list, share, footprints])
  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    const matrix = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const color = new THREE.Color()
    kept.forEach((o, i) => {
      const s = list[o + 3]!
      q.setFromAxisAngle(up, list[o + 4]!)
      // Rocks sink into the ground a little.
      const y = level(list[o]!, list[o + 2]!, list[o + 1]!)
      m.setMatrixAt(i, matrix.compose(position.set(list[o]!, y - (plant === 'rock' ? s * 0.1 : 0.05), list[o + 2]!), q, scale.setScalar(s)))
      m.setColorAt(i, instanceTint(plant, list[o + 5]!, color))
    })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.computeBoundingSphere()
    invalidate()
  }, [kept, list, plant, level, invalidate])
  if (!kept.length) return null
  return (
    <instancedMesh key={kept.length} ref={mesh} args={[plants.get(plant), undefined, kept.length]} raycast={noRaycast}>
      <meshStandardMaterial vertexColors roughness={0.95} metalness={0} flatShading />
    </instancedMesh>
  )
}

/** Structures are drawn in full while they're big on screen: within this many times their size of the camera (a house, some 240 m; a castle, 1.5 km), and never closer than `MIN_DETAIL_M`; farther, as their massing. */
const DETAIL_SIZES = 20
const MIN_DETAIL_M = 120
/** How far the camera moves before what's near is worked out again. */
const RELOD_M = 25
const MASS_BOX = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
const UP = new THREE.Vector3(0, 1, 0)
const WEATHERED = new THREE.Color(WEATHERED_COLOR)

interface GroundPlaced {
  placed: PlacedStructure
  x: number
  y: number
  z: number
  /** Within how far of the camera it's drawn in full. */
  detail: number
}

/**
 * The structures on the ground, with a level of detail: near the camera (and
 * the selected one, and any the selected event reaches) each with all its
 * parts; the rest, which are a few pixels across, as plain blocks of their
 * size and colour, all of them in one instanced mesh, so a town of hundreds
 * draws as fast as a house.
 */
function GroundStructures({ structures, ground, onClick }: { structures: PlacedStructure[]; ground: Ground; onClick(id: string): void }) {
  const get = useThree((s) => s.get)
  const all = useMemo(
    () =>
      structures.flatMap((placed): GroundPlaced[] => {
        const [x, z] = toLocal(ground.frame, placed.structure)
        if (!inView(x, z)) return []
        return [{ placed, x, y: ground.standAt(x, z), z, detail: Math.max(MIN_DETAIL_M, blueprintExtent(placed.blueprint) * placed.structure.scale * DETAIL_SIZES) }]
      }),
    [structures, ground]
  )
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set())
  // Worked out again for the frame after the structures change, or once the camera has moved a little.
  const last = useRef<{ look: THREE.Vector3; all: GroundPlaced[] } | null>(null)
  useFrame(() => {
    const at = get().camera.position
    if (last.current && last.current.all === all && last.current.look.distanceTo(at) <= RELOD_M) return
    last.current = { look: at.clone(), all }
    const next = new Set(all.filter((s) => s.placed.selected || s.placed.hit !== undefined || at.distanceTo(new THREE.Vector3(s.x, s.y, s.z)) < s.detail).map((s) => s.placed.structure.id))
    setNear((prev) => (prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next))
  })
  const { alone, batches, far } = useMemo(() => {
    const alone: GroundPlaced[] = []
    const far: GroundPlaced[] = []
    const batches = new Map<string, Batch>()
    for (const s of all) {
      if (!near.has(s.placed.structure.id)) far.push(s)
      else if (!batchable(s.placed)) alone.push(s)
      else addToBatch(batches, s)
    }
    return { alone, batches: [...batches.values()], far }
  }, [all, near])
  return (
    <>
      {alone.map((s) => (
        <GroundStructure key={s.placed.structure.id} placed={s.placed} ground={ground} onClick={onClick} />
      ))}
      {batches.map((b) => (
        <BlueprintBatch key={b.key} parts={b.parts} age={b.age} placements={b.placements} ids={b.ids} onPick={onClick} />
      ))}
      {far.length > 0 && <FarStructures key={far.length} items={far} onClick={onClick} />}
    </>
  )
}

/** Near structures that look alike, drawn together. */
interface Batch {
  key: string
  parts: BlueprintPart[]
  age: number
  placements: THREE.Matrix4[]
  ids: string[]
}

/** What's drawn alone: the selected structure and any the selected event reaches (they have rings), ruins or plans shown faintly, and imported models. */
const batchable = ({ selected, hit, state, blueprint }: PlacedStructure) => !selected && hit === undefined && state.exists && !blueprint.model

/** Puts a near structure with the others that look like it: the same blueprint, the same parts standing, weathered to within 5%. */
function addToBatch(batches: Map<string, Batch>, { placed: { structure, state, blueprint }, x, y, z }: GroundPlaced): void {
  const parts = standingParts(blueprint.parts, state.condition, state.materials)
  const age = Math.round(weatheringOf(state.condition) * 20) / 20
  const index = partIndex(blueprint)
  const key = `${blueprint.id}|${age}|${parts.length === blueprint.parts.length ? 'all' : parts.map((p) => index.get(p)).join()}`
  let batch = batches.get(key)
  if (!batch) batches.set(key, (batch = { key, parts, age, placements: [], ids: [] }))
  const scale = structure.scale
  const at = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, (-structure.rotation * Math.PI) / 180), new THREE.Vector3(scale, scale * slumpOf(state.condition), scale))
  batch.placements.push(at)
  batch.ids.push(structure.id)
}

const partIndexes = new WeakMap<Blueprint, Map<BlueprintPart, number>>()
/** Each of a blueprint's parts' place in it, to tell which are standing. */
function partIndex(b: Blueprint): Map<BlueprintPart, number> {
  let index = partIndexes.get(b)
  if (!index) partIndexes.set(b, (index = new Map(b.parts.map((p, i) => [p, i]))))
  return index
}

/** Structures far off, each a block of its massing, aged and slumped like the structure: one draw for all of them, each still picked by itself. */
function FarStructures({ items, onClick }: { items: GroundPlaced[]; onClick(id: string): void }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const invalidate = useThree((s) => s.invalidate)
  const ids = useMemo(() => items.map((s) => s.placed.structure.id), [items])
  const pick = usePickInstances(onClick, ids, 'structure')
  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    const [matrix, position, rotation, size, color] = [new THREE.Matrix4(), new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3(), new THREE.Color()]
    items.forEach(({ placed: { structure, state, blueprint }, x, y, z }, i) => {
      const mass = blueprintMassing(blueprint)
      rotation.setFromAxisAngle(UP, (-structure.rotation * Math.PI) / 180)
      size.set(mass.width, mass.height * slumpOf(state.condition), mass.depth).multiplyScalar(structure.scale)
      m.setMatrixAt(i, matrix.compose(position.set(x, y, z), rotation, size))
      m.setColorAt(i, color.set(mass.color).lerp(WEATHERED, weatheringOf(state.condition)))
    })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.computeBoundingSphere()
    invalidate()
  }, [items, invalidate])
  return (
    <instancedMesh ref={mesh} args={[MASS_BOX, undefined, items.length]} {...pick}>
      <meshStandardMaterial roughness={0.9} />
    </instancedMesh>
  )
}

/** A structure at its real size, on the level ground made for it. */
function GroundStructure({ placed, ground, onClick }: { placed: PlacedStructure; ground: Ground; onClick(id: string): void }) {
  const { structure, state, blueprint, selected, hit } = placed
  const extent = blueprintExtent(blueprint) * structure.scale
  const [x, z] = toLocal(ground.frame, structure)
  // On its levelled pad.
  const y = useMemo(() => ground.standAt(x, z), [ground, x, z])
  const pick = usePick(onClick, structure.id, 'structure')
  if (!inView(x, z)) return null
  return (
    <group
      position={[x, y, z]}
      rotation={[0, (-structure.rotation * Math.PI) / 180, 0]}
      scale={structure.scale}
      {...pick}
    >
      <BlueprintParts blueprint={blueprint} condition={state.condition} materials={state.materials} ghost={!state.exists} />
      <SelectionRing inner={(extent / structure.scale) * 0.6} outer={(extent / structure.scale) * 0.6 + Math.max(1, extent * 0.01)} segments={64} lift={0.3} selected={selected} hit={hit} />
    </group>
  )
}

const BODY = new THREE.CapsuleGeometry(0.24, 0.9, 4, 10).translate(0, 0.72, 0)
const HEAD = new THREE.SphereGeometry(0.17, 12, 10).translate(0, 1.6, 0)

/** A character, life-size: a little over 1.7 m tall. */
function Figure({ id, at, color, selected, ground, onClick }: { id: string; at: LatLon; color: string; selected: boolean; ground: Ground; onClick(id: string): void }) {
  const pick = usePick(onClick, id, 'character')
  const [x, z] = toLocal(ground.frame, at)
  if (!inView(x, z)) return null
  return (
    <group position={[x, ground.standAt(x, z), z]} {...pick}>
      <mesh geometry={BODY}>
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh geometry={HEAD}>
        <meshStandardMaterial color="#e2b48f" roughness={0.8} />
      </mesh>
      <SelectionRing inner={0.6} outer={0.75} lift={0.05} selected={selected} solid />
    </group>
  )
}

const POST = new THREE.CylinderGeometry(0.8, 0.8, 40, 8)

/** Where an event happened: a tall coloured post, seen from afar. */
function Beacon({ id, at, color, lit, ground, onClick }: { id: string; at: LatLon; color: string; lit: boolean; ground: Ground; onClick(id: string): void }) {
  const pick = usePick(onClick, id, 'event')
  const [x, z] = toLocal(ground.frame, at)
  if (!inView(x, z)) return null
  return (
    <mesh position={[x, ground.standAt(x, z) + 20, z]} geometry={POST} {...pick}>
      <meshBasicMaterial color={color} transparent opacity={lit ? 0.95 : 0.5} />
    </mesh>
  )
}

/** Where the middle of the view is, how to get back up, and why some of the ground is missing if it is. */
function GroundReadout({ ground, error }: { ground: Ground; error?: string }) {
  const { lat, lon } = ground.frame.origin
  return (
    <div className="ground-readout small" data-testid="ground-readout">
      <span>
        {Math.abs(lat).toFixed(4)}°{lat >= 0 ? 'N' : 'S'} {Math.abs(lon).toFixed(4)}°{lon >= 0 ? 'E' : 'W'}
      </span>
      {error && <span role="alert">Couldn’t build the ground here: {error}</span>}
      <button className="link" onClick={() => useEditor.getState().leaveGround(ground.frame.origin)}>
        ⬆ Back up
      </button>
    </div>
  )
}
