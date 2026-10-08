import type { LatLon } from '@universe/core'
import {
  CHUNK_M,
  GroundDetail,
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
import { OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useEditor } from './editorStore'
import { LabelLayer, LabelProjector, type ViewLabel } from './labels'
import { NEAR_ONLY, instanceTint, plantGeometry } from './plants'
import { blueprintExtent } from './structureLook'
import { BlueprintParts } from './StructureMesh'
import { useGroundChunks } from './useGroundChunks'
import type { PlacedStructure } from './useStructures'
import type { SurfaceViewProps } from './useTerrain'

const SKY = '#a9cdea'
/** Chunks drawn around the middle of the view in each direction: a 5 × 5 km square. */
const RING = 2
/** Farthest the camera pulls back; scrolling out past it returns to the globe. */
const MAX_DISTANCE = 2600
/** Things farther than this from the middle of the view aren't drawn (the fog has them). */
const DRAW_M = 3800
const RAD = Math.PI / 180

/** Heights of the ground anywhere: the globe's terrain plus the seeded detail the chunks have. */
interface Ground {
  frame: LocalFrame
  /** Metres above sea level at a point of the frame. */
  heightAt(x: number, z: number): number
  heightAtLatLon(p: LatLon): number
}

/**
 * The world up close, in metres: terrain in 1 km chunks with its trees,
 * grass and rocks; structures at their real size; characters on foot. Opened
 * by scrolling all the way in on the globe (or the Ground button); scrolling
 * all the way out goes back up.
 */
export function GroundView(props: SurfaceViewProps & { seed: number }) {
  const start = useEditor((s) => s.ground) ?? { lat: 0, lon: 0 }
  const tool = useEditor((s) => s.tool)
  const [origin, setOrigin] = useState<LatLon>(start)
  const [center, setCenter] = useState<LatLon>(start)
  const { model, change, seed } = props
  const radiusKm = model.settings.radiusKm
  const ground = useMemo<Ground>(() => {
    const frame = { origin, radiusKm }
    const detail = new GroundDetail(seed, radiusKm)
    const base = modelSampler(model)
    const heightAtLatLon = (p: LatLon) => detail.elevation(base, p.lat, p.lon)
    return { frame, heightAtLatLon, heightAt: (x, z) => heightAtLatLon(fromLocal(frame, x, z)) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `change` stands for the terrain heights
  }, [origin, radiusKm, seed, model, change])

  const labels = useMemo(() => new Map<string, HTMLDivElement>(), [])
  const items = useMemo(() => groundLabels(props, ground), [props, ground])

  return (
    <div className="globe-wrap">
      <Canvas camera={{ position: [0, 400, 600], fov: 55, near: 0.5, far: 9000 }} data-testid="ground" gl={{ preserveDrawingBuffer: true }}>
        <color attach="background" args={[SKY]} />
        <fog attach="fog" args={[SKY, 1400, 3400]} />
        <hemisphereLight args={['#dce9f7', '#4a4536', 0.75]} />
        <directionalLight position={[700, 650, 250]} intensity={1.6} />
        <Rig ground={ground} onRebase={setOrigin} onCenter={setCenter} />
        <Chunks {...props} ground={ground} center={center} />
        <Water color={model.settings.terrain.waterColor} />
        {props.structures.map((p) => (
          <GroundStructure key={p.structure.id} placed={p} ground={ground} onClick={props.onStructureClick} />
        ))}
        {props.characters.map((c) => (
          <Figure key={c.character.id} at={c.place} color={c.character.color} selected={c.selected} ground={ground} onClick={() => props.onCharacterClick(c.character.id)} />
        ))}
        {props.pins.map((p, i) => (
          <Beacon key={`${p.eventId}:${i}`} at={p} color={p.color} lit={p.active || p.selected} ground={ground} onClick={() => props.onPinClick(p.eventId)} />
        ))}
        <LabelProjector items={items} labels={labels} />
        <OrbitControls
          makeDefault
          screenSpacePanning={false}
          minDistance={3}
          maxDistance={MAX_DISTANCE}
          maxPolarAngle={Math.PI * 0.47}
          zoomSpeed={0.9}
          // Dragging moves over the ground like a map; right-drag looks around. With a tool, left-drag is the tool's.
          mouseButtons={{
            LEFT: tool === 'navigate' ? THREE.MOUSE.PAN : (-1 as THREE.MOUSE),
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: THREE.MOUSE.ROTATE
          }}
        />
      </Canvas>
      <LabelLayer items={items} labels={labels} />
      <GroundReadout ground={ground} />
    </div>
  )
}

/** Labels for structures that show their name (or are selected), characters, and active or selected events. */
function groundLabels({ structures, characters, pins }: SurfaceViewProps, ground: Ground): ViewLabel[] {
  const at = (p: LatLon, lift: number) => {
    const [x, z] = toLocal(ground.frame, p)
    const point: [number, number, number] = [x, Math.max(0, ground.heightAt(x, z)) + lift, z]
    return (camera: THREE.Camera) => (camera.position.distanceTo(new THREE.Vector3(...point)) < DRAW_M ? point : null)
  }
  return [
    ...structures.flatMap((s) =>
      (s.structure.label && s.state.exists) || s.selected
        ? [{ key: `structure:${s.structure.id}`, text: s.state.name, selected: s.selected, at: at(s.structure, blueprintExtent(s.blueprint) * s.structure.scale * 0.6 + 4) }]
        : []
    ),
    ...characters.map((c) => ({ key: `character:${c.character.id}`, text: c.character.name, selected: c.selected, at: at(c.place, 2.4) })),
    ...pins.flatMap((p, i) => (p.active || p.selected ? [{ key: `pin:${p.eventId}:${i}`, text: p.title, selected: p.selected, at: at(p, 46) }] : []))
  ]
}

/**
 * Keeps the camera above the ground and its target on it, re-centres the
 * frame when the view has moved far from its origin, tells which chunk the
 * middle of the view is in, and goes back up to the globe when scrolled out.
 */
function Rig({ ground, onRebase, onCenter }: { ground: Ground; onRebase(origin: LatLon): void; onCenter(center: LatLon): void }) {
  // Through `get`, so the camera and controls are the scene's to move, not values held by this component.
  const get = useThree((s) => s.get)
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
    const y = Math.max(0, ground.heightAt(0, 0))
    const d = useEditor.getState().groundDistance
    controls.target.set(0, y, 0)
    camera.position.set(0, y + d * 0.6, d * 0.8)
    controls.update()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the controls exist
  }, [hasControls])

  useFrame(() => {
    const { camera, controls } = rig()
    if (!controls) return
    const t = controls.target
    t.y = Math.max(0, ground.heightAt(t.x, t.z))
    const floor = Math.max(0, ground.heightAt(camera.position.x, camera.position.z)) + 1.7
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
    let pushes = 0
    const onWheel = (e: WheelEvent) => {
      const { camera, controls } = rig()
      if (!controls) return
      pushes = e.deltaY > 0 && camera.position.distanceTo(controls.target) >= MAX_DISTANCE - 1 ? pushes + 1 : 0
      if (pushes >= 3) useEditor.getState().leaveGround(fromLocal(ground.frame, controls.target.x, controls.target.z))
    }
    gl.domElement.addEventListener('wheel', onWheel, { passive: true })
    return () => gl.domElement.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `rig` reads the live scene
  }, [ground])
  return null
}

/** The sea: a sheet at sea level that follows the view. */
function Water({ color }: { color: string }) {
  const mesh = useRef<THREE.Mesh>(null)
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null
  useFrame(() => {
    if (mesh.current && controls) mesh.current.position.set(controls.target.x, 0, controls.target.z)
  })
  return (
    <mesh ref={mesh} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
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

function Chunks(props: SurfaceViewProps & { seed: number; ground: Ground; center: LatLon }) {
  const { model, change, seed, ground, center, structures } = props
  const radiusKm = model.settings.radiusKm
  const wanted = useMemo(() => chunksAround(center, radiusKm, RING), [center, radiusKm])
  const chunks = useGroundChunks(model, change, seed, wanted)
  const middle = chunkOf(center, radiusKm)
  const foliage = useMemo(() => new THREE.Color(model.settings.terrain.vegetationColor), [model.settings.terrain.vegetationColor])
  const footprints = useMemo<Footprint[]>(
    () =>
      structures.flatMap(({ structure, state, blueprint }) => {
        // Ruins are overgrown; standing buildings keep their ground clear.
        if (!state.exists || state.condition < 20) return []
        const [x, z] = toLocal(ground.frame, structure)
        return [{ x, z, r: blueprintExtent(blueprint) * structure.scale * 0.55 }]
      }),
    [structures, ground.frame]
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
            foliage={foliage}
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
function ChunkView({
  chunk,
  ring,
  ground,
  foliage,
  footprints,
  onPointerDown,
  onPointerMove
}: {
  chunk: GroundChunk
  ring: number
  ground: Ground
  foliage: THREE.Color
  footprints: Footprint[]
  onPointerDown: SurfaceViewProps['onPointerDown']
  onPointerMove: SurfaceViewProps['onPointerMove']
}) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3))
    // The chunk's colours are sRGB, like the map's; the renderer works in linear light.
    const color = new THREE.Color()
    const colors = new Float32Array(chunk.colors.length)
    for (let i = 0; i < colors.length; i += 3) color.setRGB(chunk.colors[i]!, chunk.colors[i + 1]!, chunk.colors[i + 2]!, THREE.SRGBColorSpace).toArray(colors, i)
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.setIndex(new THREE.BufferAttribute(chunk.indices, 1))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    return g
  }, [chunk])
  useEffect(() => () => geometry.dispose(), [geometry])
  const bounds = chunkBounds(chunk.id, ground.frame.radiusKm)
  const [x, z] = toLocal(ground.frame, { lat: bounds.lat0, lon: bounds.lon0 })
  // East-west, the view's frame and the chunk's own differ by the ratio of their latitudes' cosines.
  const stretch = Math.cos(ground.frame.origin.lat * RAD) / Math.cos(bounds.lat0 * RAD)
  const local = useMemo(() => footprints.map((f) => ({ x: (f.x - x) / stretch, z: f.z - z, r: f.r })).filter((f) => f.x > -f.r && f.x < CHUNK_M * 1.5 + f.r && f.z < f.r && f.z > -CHUNK_M * 1.5 - f.r), [footprints, x, z, stretch])
  const dir = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    const p = fromLocal(ground.frame, e.point.x, e.point.z)
    return latLonToDir(p.lat, p.lon)
  }
  return (
    <group position={[x, 0, z]} scale={[stretch, 1, 1]}>
      <mesh
        geometry={geometry}
        onPointerDown={(e) => {
          if (e.button === 0 && onPointerDown(dir(e))) e.stopPropagation()
        }}
        onPointerMove={(e) => onPointerMove(dir(e))}
      >
        <meshStandardMaterial vertexColors roughness={1} metalness={0} />
      </mesh>
      {Object.entries(chunk.plants).map(([plant, list]) =>
        ring > 0 && NEAR_ONLY.includes(plant as Plant) ? null : (
          <PlantInstances key={plant} plant={plant as Plant} list={list} share={RING_SHARE[ring] ?? 0} foliage={foliage} footprints={local} />
        )
      )}
    </group>
  )
}

/** How much of a chunk's plants are drawn, by its distance in chunks from the middle of the view: the far ones are thinned. */
const RING_SHARE = [1, 0.55, 0.25]

const geometries = new Map<string, THREE.BufferGeometry>()
function sharedPlantGeometry(plant: Plant, foliage: THREE.Color): THREE.BufferGeometry {
  const key = `${plant}:${foliage.getHexString()}`
  let g = geometries.get(key)
  if (!g) geometries.set(key, (g = plantGeometry(plant, foliage)))
  return g
}

/** All of one kind of plant on a chunk, as one instanced mesh; `share` draws only that fraction of them (farther chunks). */
function PlantInstances({ plant, list, share, foliage, footprints }: { plant: Plant; list: Float32Array; share: number; foliage: THREE.Color; footprints: Footprint[] }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
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
    const color = new THREE.Color()
    kept.forEach((o, i) => {
      const s = list[o + 3]!
      q.setFromAxisAngle(up, list[o + 4]!)
      // Rocks sink into the ground a little.
      m.setMatrixAt(i, matrix.compose(new THREE.Vector3(list[o]!, list[o + 1]! - (plant === 'rock' ? s * 0.1 : 0.05), list[o + 2]!), q, new THREE.Vector3(s, s, s)))
      m.setColorAt(i, instanceTint(plant, list[o + 5]!, color))
    })
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.computeBoundingSphere()
  }, [kept, list, plant])
  if (!kept.length) return null
  return (
    <instancedMesh key={kept.length} ref={mesh} args={[sharedPlantGeometry(plant, foliage), undefined, kept.length]} raycast={() => null}>
      <meshStandardMaterial vertexColors roughness={0.95} metalness={0} flatShading />
    </instancedMesh>
  )
}

/** A structure at its real size, sitting on the lowest ground under it so no corner floats. */
function GroundStructure({ placed, ground, onClick }: { placed: PlacedStructure; ground: Ground; onClick(id: string): void }) {
  const { structure, state, blueprint, selected, hit } = placed
  const extent = blueprintExtent(blueprint) * structure.scale
  const [x, z] = toLocal(ground.frame, structure)
  const y = useMemo(() => {
    const r = extent * 0.35
    const around = Array.from({ length: 8 }, (_, k) => ground.heightAt(x + Math.cos((k * Math.PI) / 4) * r, z + Math.sin((k * Math.PI) / 4) * r))
    return Math.max(0, Math.min(ground.heightAt(x, z), ...around))
  }, [ground, x, z, extent])
  if (Math.hypot(x, z) > DRAW_M) return null
  return (
    <group
      position={[x, y, z]}
      rotation={[0, (-structure.rotation * Math.PI) / 180, 0]}
      scale={structure.scale}
      onPointerDown={(e) => {
        if (e.button !== 0 || useEditor.getState().tool !== 'navigate') return
        e.stopPropagation()
        onClick(structure.id)
      }}
    >
      <BlueprintParts blueprint={blueprint} condition={state.condition} ghost={!state.exists} />
      {(selected || hit !== undefined) && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.3, 0]} raycast={() => null}>
          <ringGeometry args={[(extent / structure.scale) * 0.6, (extent / structure.scale) * 0.66, 48]} />
          <meshBasicMaterial color={selected ? '#ffffff' : '#ff5a5a'} transparent opacity={selected ? 0.9 : 0.35 + 0.6 * (hit ?? 0)} depthTest={false} />
        </mesh>
      )}
    </group>
  )
}

const BODY = new THREE.CapsuleGeometry(0.24, 0.9, 4, 10).translate(0, 0.72, 0)
const HEAD = new THREE.SphereGeometry(0.17, 12, 10).translate(0, 1.6, 0)

/** A character, life-size: a little over 1.7 m tall. */
function Figure({ at, color, selected, ground, onClick }: { at: LatLon; color: string; selected: boolean; ground: Ground; onClick(): void }) {
  const [x, z] = toLocal(ground.frame, at)
  if (Math.hypot(x, z) > DRAW_M) return null
  return (
    <group
      position={[x, Math.max(0, ground.heightAt(x, z)), z]}
      onPointerDown={(e) => {
        if (e.button !== 0 || useEditor.getState().tool !== 'navigate') return
        e.stopPropagation()
        onClick()
      }}
    >
      <mesh geometry={BODY}>
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh geometry={HEAD}>
        <meshStandardMaterial color="#e2b48f" roughness={0.8} />
      </mesh>
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} raycast={() => null}>
          <ringGeometry args={[0.6, 0.75, 32]} />
          <meshBasicMaterial color="#ffffff" depthTest={false} />
        </mesh>
      )}
    </group>
  )
}

/** Where an event happened: a tall coloured post, seen from afar. */
function Beacon({ at, color, lit, ground, onClick }: { at: LatLon; color: string; lit: boolean; ground: Ground; onClick(): void }) {
  const [x, z] = toLocal(ground.frame, at)
  if (Math.hypot(x, z) > DRAW_M) return null
  return (
    <mesh
      position={[x, Math.max(0, ground.heightAt(x, z)) + 20, z]}
      onPointerDown={(e) => {
        if (e.button !== 0 || useEditor.getState().tool !== 'navigate') return
        e.stopPropagation()
        onClick()
      }}
    >
      <cylinderGeometry args={[0.8, 0.8, 40, 8]} />
      <meshBasicMaterial color={color} transparent opacity={lit ? 0.95 : 0.5} />
    </mesh>
  )
}

/** Where the middle of the view is, and how to get back up. */
function GroundReadout({ ground }: { ground: Ground }) {
  const { lat, lon } = ground.frame.origin
  return (
    <div className="ground-readout small" data-testid="ground-readout">
      <span>
        {Math.abs(lat).toFixed(4)}°{lat >= 0 ? 'N' : 'S'} {Math.abs(lon).toFixed(4)}°{lon >= 0 ? 'E' : 'W'}
      </span>
      <button className="link" onClick={() => useEditor.getState().leaveGround(ground.frame.origin)}>
        ⬆ Back up
      </button>
    </div>
  )
}
