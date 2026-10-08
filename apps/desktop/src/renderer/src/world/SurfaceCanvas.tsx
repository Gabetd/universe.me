import { OrbitControls, type OrbitControlsProps } from '@react-three/drei'
import { Canvas, addAfterEffect, useThree } from '@react-three/fiber'
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import * as THREE from 'three'
import { useEditor } from './editorStore'
import { LabelLayer, LabelProjector, type ViewLabel } from './labels'
import { WEBGL } from './webgl'

/** Kept for screenshots and the zoom's still of the view; antialiasing only with a GPU. */
const GL = { preserveDrawingBuffer: true, antialias: !WEBGL.software }

/** Sets the view's `data-ready`. */
const ReadyContext = createContext<(ready: boolean) => void>(() => {})

/**
 * The canvas the globe and the ground are drawn in, with their labels and
 * camera controls. A frame is drawn only when something changes (the camera
 * moves, the scene changes, or a view calls `invalidate`), so a view that's
 * just being looked at costs nothing. Its `data-ready` tells tests when what
 * it shows is in (see `useReadyWhenDrawn`).
 */
export function SurfaceCanvas({
  testId,
  camera,
  navigate,
  controls,
  labels,
  wrap,
  overlay,
  children
}: {
  testId: string
  camera: ComponentProps<typeof Canvas>['camera']
  /** What a left-drag does with the navigate tool; with another tool, left-drag is the tool's and right-drag still turns the view. */
  navigate: THREE.MOUSE
  controls: Omit<OrbitControlsProps, 'makeDefault' | 'mouseButtons'>
  labels: ViewLabel[]
  /** Attributes of the wrapper, for tests to wait on. */
  wrap?: Record<`data-${string}`, string | number>
  /** Over the canvas, outside the scene. */
  overlay?: ReactNode
  children: ReactNode
}) {
  const tool = useEditor((s) => s.tool)
  const [ready, setReady] = useState(false)
  const labelEls = useMemo(() => new Map<string, HTMLDivElement>(), [])
  const mouseButtons = useMemo(
    () => ({ LEFT: tool === 'navigate' ? navigate : (-1 as THREE.MOUSE), MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }),
    [tool, navigate]
  )
  return (
    <div className="globe-wrap" {...wrap}>
      <Canvas camera={camera} data-testid={testId} data-ready={ready} frameloop="demand" gl={GL}>
        <ReadyContext value={setReady}>
          <Scene>{children}</Scene>
        </ReadyContext>
        {/* After the scene, so labels follow where it has just moved the camera. */}
        <LabelProjector items={labels} labels={labelEls} />
        <RedrawOnResize />
        <OrbitControls makeDefault {...controls} mouseButtons={mouseButtons} />
      </Canvas>
      <LabelLayer items={labels} labels={labelEls} />
      {overlay}
    </div>
  )
}

/**
 * The view's scene. r3f draws a frame when objects are added or changed, but
 * not when they're taken away (a structure gone, a ring put away): this draws
 * one whenever the view renders with fewer objects than before. Parts of a
 * scene that take objects away on their own (not as the view renders) call
 * `invalidate` themselves.
 */
function Scene({ children }: { children: ReactNode }) {
  const scene = useThree((s) => s.scene)
  const invalidate = useThree((s) => s.invalidate)
  const objects = useRef(0)
  useLayoutEffect(() => {
    let count = 0
    scene.traverse(() => void count++)
    if (count < objects.current) invalidate()
    objects.current = count
  })
  return <>{children}</>
}

/** Resizing the canvas clears it: draw it again. */
function RedrawOnResize() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate(), [size, dpr, invalidate])
  return null
}

/**
 * The view's `data-ready` turns "true" once a frame has been drawn while
 * `ready` (what it waits for is in), and is "false" until then.
 */
export function useReadyWhenDrawn(ready: boolean) {
  const setReady = useContext(ReadyContext)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    setReady(false)
    if (!ready) return
    invalidate()
    // After-effects run once the frame has been drawn.
    const stop = addAfterEffect(() => {
      stop()
      setReady(true)
    })
    return stop
  }, [ready, setReady, invalidate])
}
