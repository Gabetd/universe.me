import type { MediaItem } from '@universe/core'
import { OrbitControls } from '@react-three/drei'
import { Canvas, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useAssetUrl, useBlendScene } from '../media/assets'
import type { BlendMesh, BlendScene } from '../media/blend'
import { useUi } from '../store'
import { isPhoneApp } from '../webBridge'
import { LAYOUT_SIZE } from '../world/SurfaceCanvas'
import { Modal } from './Modal'
import { Thumbnail } from './Thumbnail'

/** One of a record's pictures or scenes, large; ← and → go through the others. */
export function MediaViewer({ media, index, onIndex, onClose }: { media: MediaItem[]; index: number; onIndex(i: number): void; onClose(): void }) {
  const item = media[index]!
  const step = (by: number) => onIndex((index + by + media.length) % media.length)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (media.length < 2 || (e.target as HTMLElement | null)?.closest('input, textarea, select')) return
      if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  return (
    <Modal title={item.name} closeLabel="Close the viewer" className="media-viewer" onClose={onClose}>
      <div className="media-stage">{item.kind === 'image' ? <PictureView item={item} /> : <BlendView item={item} />}</div>
      <footer className="media-footer">
        {media.length > 1 && (
          <>
            <button aria-label="Previous" onClick={() => step(-1)}>
              ←
            </button>
            <span className="muted small">
              {index + 1} of {media.length}
            </span>
            <button aria-label="Next" onClick={() => step(1)}>
              →
            </button>
          </>
        )}
        {item.kind === 'blend' && !isPhoneApp() && (
          <button className="media-open" title="Opens a copy: what’s kept in the project stays as it is" onClick={() => void useUi.getState().run(window.universe.openAsset(item.assetId))}>
            Open a copy in Blender
          </button>
        )}
      </footer>
    </Modal>
  )
}

function PictureView({ item }: { item: MediaItem }) {
  const url = useAssetUrl(item.assetId)
  return url ? <img className="media-picture" src={url} alt={item.name} /> : <p className="muted">Loading…</p>
}

const nf = new Intl.NumberFormat()

function BlendView({ item }: { item: MediaItem }) {
  const loaded = useBlendScene(item.assetId)
  if (loaded.state === 'loading') return <p className="muted">Reading {item.name}…</p>
  if (loaded.state === 'failed')
    return (
      <p className="error small">
        {item.name} couldn’t be read: {loaded.error}
      </p>
    )
  const scene = loaded.value
  const triangles = scene.meshes.reduce((n, m) => n + m.indices.length / 3, 0)
  const summary = [
    `Blender ${scene.version}`,
    `${scene.meshes.length} ${scene.meshes.length === 1 ? 'mesh' : 'meshes'}`,
    `${nf.format(triangles)} triangles`,
    ...(scene.others ? [`${scene.others} other ${scene.others === 1 ? 'object' : 'objects'} (cameras, lights, curves…) not drawn`] : []),
    ...(scene.cut ? ['too big to draw whole'] : [])
  ].join(' · ')
  return (
    <div className="blend-view" data-testid="blend-view" data-meshes={scene.meshes.length} data-triangles={triangles}>
      {scene.meshes.length > 0 ? (
        <Canvas camera={{ fov: 40, near: 0.01, far: 1000 }} resize={LAYOUT_SIZE} gl={{ preserveDrawingBuffer: true }}>
          <BlendStage scene={scene} />
        </Canvas>
      ) : scene.thumbnail ? (
        <Thumbnail className="media-picture" picture={scene.thumbnail} label={`${item.name}, as Blender saved it`} />
      ) : (
        <p className="muted">There are no meshes in this scene to show.</p>
      )}
      <p className="muted small media-summary">{summary}. Drag to turn it, scroll to zoom. Modifiers aren’t applied.</p>
    </div>
  )
}

/** Blender's Z up becomes the viewer's Y up. */
const Z_UP = new THREE.Euler(-Math.PI / 2, 0, 0)

function BlendStage({ scene }: { scene: BlendScene }) {
  const geometries = useMemo(() => scene.meshes.map(geometryOf), [scene])
  useEffect(() => () => geometries.forEach((g) => g.dispose()), [geometries])
  // Where it all is, turned Y up, to point the camera at.
  const bounds = useMemo(() => {
    const box = new THREE.Box3()
    for (const g of geometries) box.union(g.boundingBox!)
    return box.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(Z_UP))
  }, [geometries])
  const size = bounds.getSize(new THREE.Vector3()).length() || 1
  const center = bounds.getCenter(new THREE.Vector3())
  return (
    <>
      <color attach="background" args={['#11141d']} />
      <hemisphereLight args={['#dfe8ff', '#3a3226', 1.4]} />
      <directionalLight position={[size, size * 2, size * 1.5]} intensity={2.2} />
      <group rotation={Z_UP}>
        {geometries.map((g, i) => (
          <mesh key={i} geometry={g}>
            <meshStandardMaterial color={new THREE.Color().setRGB(...scene.meshes[i]!.color, THREE.LinearSRGBColorSpace)} flatShading side={THREE.DoubleSide} roughness={0.7} />
          </mesh>
        ))}
      </group>
      <gridHelper args={[size * 2, 20, '#3a4566', '#232a3d']} position={[center.x, bounds.min.y, center.z]} />
      <FitCamera bounds={bounds} />
    </>
  )
}

function geometryOf(mesh: BlendMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
  g.computeBoundingBox()
  return g
}

/** Looks at the whole scene from the front and a little above, far enough back to see all of it. */
function FitCamera({ bounds }: { bounds: THREE.Box3 }) {
  const get = useThree((s) => s.get)
  const controls = useThree((s) => s.controls)
  useLayoutEffect(() => {
    const { camera } = get()
    const center = bounds.getCenter(new THREE.Vector3())
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 1e-3)
    const perspective = camera as THREE.PerspectiveCamera
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(perspective.fov / 2))
    camera.position.copy(center).add(new THREE.Vector3(0.6, 0.45, 1).normalize().multiplyScalar(distance))
    perspective.near = distance / 100
    perspective.far = distance * 100
    perspective.updateProjectionMatrix()
    const orbit = controls as unknown as { target: THREE.Vector3; update(): void } | null
    orbit?.target.copy(center)
    orbit?.update()
    camera.lookAt(center)
  }, [bounds, get, controls])
  return <OrbitControls makeDefault />
}
