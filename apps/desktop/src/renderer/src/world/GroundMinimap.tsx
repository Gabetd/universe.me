import type { LatLon } from '@universe/core'
import { RAD, fromLocal, groundMapBounds, sampleBaseGrid, toLocal, watersNear, type GroundMapInput, type TerrainModel } from '@universe/procgen'
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { workerCalls } from '../workerCalls'
import { useEditor } from './editorStore'
import GroundMapWorker from './ground-map.worker?worker'
import type { AreaWaters } from './groundWater'
import { sources } from './useGroundChunks'
import type { TerrainChange } from './useTerrain'

const W = 220
const H = 110
/** The area shown, in km²: some 32 km across by 16 down. */
export const MINIMAP_KM2 = 500
/** Metres a pixel of it is across. */
export const MINIMAP_MPP = Math.sqrt(MINIMAP_KM2 * 1e6 * (W / H)) / W
/** Pixels of the picture past each edge, so it slides under the arrow as the view moves before it's drawn again. */
const PAD = 24
/** The picture is drawn again for each square of this many metres the view moves into (well inside `PAD`). */
const STEP_M = 1000
/** How far the camera moves (degrees) or turns (radians) before the arrow is drawn again: under a pixel of the map. */
const MOVED_DEG = 0.0005
const TURNED = Math.PI / 180
const ORIGIN: LatLon = { lat: 0, lon: 0 }

const drawMap = workerCalls<GroundMapInput, Uint8ClampedArray>(() => new GroundMapWorker())

/** Where the ground view's camera is and which way it faces (radians clockwise from north): set by the view as it moves. */
export const useGroundPose = create<{ at: LatLon | null; heading: number; move(at: LatLon, heading: number): void }>((set, get) => ({
  at: null,
  heading: 0,
  move: (at, heading) => {
    const was = get()
    const turned = Math.abs(Math.atan2(Math.sin(heading - was.heading), Math.cos(heading - was.heading)))
    if (was.at && Math.abs(at.lat - was.at.lat) < MOVED_DEG && Math.abs(at.lon - was.at.lon) < MOVED_DEG && turned < TURNED) return
    set({ at, heading })
  }
}))

/** The middle of the picture for a camera at `at`: the corner of the STEP_M square it's in. */
function pictureMiddle(at: LatLon, radiusKm: number): LatLon {
  const step = STEP_M / (radiusKm * 1000 * RAD)
  const lat = Math.round(at.lat / step) * step
  const lonStep = step / Math.max(0.02, Math.cos(lat * RAD))
  return { lat, lon: Math.round(at.lon / lonStep) * lonStep }
}

/**
 * Where you are on the ground, in the corner of the ground view: the land
 * around the camera, some 500 km² of it (32 by 16 km), drawn from above (see
 * `buildGroundMap`), with an arrow the way it faces. Clicking it goes there.
 */
export function GroundMinimap({ model, change, seed, waters }: { model: TerrainModel; change: TerrainChange; seed: number; waters: AreaWaters | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  // Until the view has moved, where it opened.
  const opened = useEditor((s) => s.ground)
  const at = useGroundPose((s) => s.at) ?? opened ?? ORIGIN
  const heading = useGroundPose((s) => s.heading)
  const radiusKm = model.settings.radiusKm
  // Forgotten when the view goes, so the next one starts from where it opens.
  useEffect(() => () => useGroundPose.setState({ at: null, heading: 0 }), [])

  // The picture of the land around, drawn in a worker for each square the view moves into.
  const [picture, setPicture] = useState<{ middle: LatLon; image: HTMLCanvasElement }>()
  const middle = pictureMiddle(at, radiusKm)
  const key = `${middle.lat},${middle.lon}`
  useEffect(() => {
    let current = true
    const { palette, water, base } = sources(model)
    const size = { frame: { origin: middle, radiusKm }, width: W + 2 * PAD, height: H + 2 * PAD, metresPerPixel: MINIMAP_MPP }
    const bounds = groundMapBounds(size)
    void drawMap({ ...size, ...palette, seed, grid: sampleBaseGrid(base, bounds, 33), waters: waters && watersNear(waters, bounds, radiusKm), waterColor: water }).then(
      (pixels) => {
        if (!current) return
        const image = document.createElement('canvas')
        image.width = size.width
        image.height = size.height
        image.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), size.width, size.height), 0, 0)
        setPicture({ middle, image })
      },
      // Without it, the arrow alone; tried again with the next square.
      () => {}
    )
    return () => void (current = false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `middle`
  }, [key, model, change, seed, waters, radiusKm])

  useEffect(() => {
    const c = canvas.current?.getContext('2d')
    if (!c) return
    c.fillStyle = '#0a0e18'
    c.fillRect(0, 0, W, H)
    if (picture) {
      // The picture's middle is where it was drawn for; the camera has moved on a little since.
      const [dx, dz] = toLocal({ origin: picture.middle, radiusKm }, at)
      c.drawImage(picture.image, Math.round(W / 2 - picture.image.width / 2 - dx / MINIMAP_MPP), Math.round(H / 2 - picture.image.height / 2 - dz / MINIMAP_MPP))
    }

    // The camera, in the middle, facing `heading`.
    c.save()
    c.translate(W / 2, H / 2)
    c.rotate(heading)
    c.beginPath()
    c.moveTo(0, -10)
    c.lineTo(7, 7)
    c.lineTo(0, 3)
    c.lineTo(-7, 7)
    c.closePath()
    c.fillStyle = '#ff5a5a'
    c.strokeStyle = '#fff'
    c.lineWidth = 2
    c.lineJoin = 'round'
    c.stroke()
    c.fill()
    c.restore()
  }, [picture, at, heading, radiusKm])

  // In a box of its own: the view's rules place every canvas in it over the whole view.
  return (
    <div className="ground-minimap">
      <canvas
        ref={canvas}
        width={W}
        height={H}
        data-testid="ground-minimap"
        data-at={`${at.lat.toFixed(4)},${at.lon.toFixed(4)}`}
        data-heading={Math.round((((heading * 180) / Math.PI) % 360 + 360) % 360)}
        data-drawn={picture ? 'true' : 'false'}
        aria-label="The land around you, some 32 by 16 km, and which way you face: click to go there"
        title="The land around you, some 32 by 16 km, and which way you face: click to go there"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const x = (((e.clientX - rect.left) / rect.width) * W - W / 2) * MINIMAP_MPP
          const z = (((e.clientY - rect.top) / rect.height) * H - H / 2) * MINIMAP_MPP
          useEditor.getState().enterGround(fromLocal({ origin: at, radiusKm }, x, z))
        }}
      />
    </div>
  )
}
