import { OrbitControls, type OrbitControlsProps } from '@react-three/drei'
import { Canvas, useThree } from '@react-three/fiber'
import { useEffect, useMemo, type ComponentProps, type ReactNode } from 'react'
import * as THREE from 'three'
import { useEditor } from './editorStore'
import { LabelLayer, LabelProjector, type ViewLabel } from './labels'
import { WEBGL } from './webgl'

/** Kept for screenshots and the zoom's still of the view; antialiasing only with a GPU. */
const GL = { preserveDrawingBuffer: true, antialias: !WEBGL.software }

/**
 * The canvas the globe and the ground are drawn in, with their labels and
 * camera controls. A frame is drawn only when something changes (the camera
 * moves, the scene changes, or a view calls `invalidate`), so a view that's
 * just being looked at costs nothing.
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
  const labelEls = useMemo(() => new Map<string, HTMLDivElement>(), [])
  const mouseButtons = useMemo(
    () => ({ LEFT: tool === 'navigate' ? navigate : (-1 as THREE.MOUSE), MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }),
    [tool, navigate]
  )
  return (
    <div className="globe-wrap" {...wrap}>
      <Canvas camera={camera} data-testid={testId} frameloop="demand" gl={GL}>
        {children}
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

/** Resizing the canvas clears it: draw it again. */
function RedrawOnResize() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate(), [size, dpr, invalidate])
  return null
}
