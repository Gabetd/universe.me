import type { LatLon } from '@universe/core'
import { latLonToPixel, pixelToLatLon, type TerrainModel } from '@universe/procgen'
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { useEditor } from './editorStore'
import { planetMap } from './MapView'
import type { TerrainChange } from './useTerrain'

const W = 220
const H = 110
/** The map's share shown: a fiftieth of it, so each side is 1/√50 of the map's. */
const SHARE = 1 / 50
const ZOOM = 1 / Math.sqrt(SHARE)
/** How far the camera moves (degrees) or turns (radians) before the map is drawn again: under a pixel of it. */
const MOVED_DEG = 0.05
const TURNED = Math.PI / 180
const ORIGIN: LatLon = { lat: 0, lon: 0 }

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

/**
 * Where you are on the ground, in the corner of the ground view: a fiftieth
 * of the planet's map, centred on the camera, with an arrow the way it faces.
 * Clicking it goes down to the ground there.
 */
export function GroundMinimap({ model, change }: { model: TerrainModel; change: TerrainChange }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const seen = useRef<TerrainChange>(undefined)
  // Until the view has moved, where it opened.
  const opened = useEditor((s) => s.ground)
  const at = useGroundPose((s) => s.at) ?? opened ?? ORIGIN
  const heading = useGroundPose((s) => s.heading)
  // Forgotten when the view goes, so the next one starts from where it opens.
  useEffect(() => () => useGroundPose.setState({ at: null, heading: 0 }), [])

  useEffect(() => {
    const c = canvas.current?.getContext('2d')
    if (!c) return
    const map = planetMap(model, change, seen.current)
    seen.current = change
    const [mw, mh] = [map.width, map.height]
    const [px, py] = latLonToPixel(at.lat, at.lon, mw, mh)
    const k = (W / mw) * ZOOM
    c.fillStyle = '#0a0e18'
    c.fillRect(0, 0, W, H)
    c.save()
    c.translate(W / 2, H / 2)
    c.scale(k, k)
    c.translate(-px, -py)
    // Round the date line: the map again on either side.
    for (const dx of [-mw, 0, mw]) c.drawImage(map, dx, 0)
    c.restore()

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
  }, [model, change, at, heading])

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
        aria-label="Where you are on the planet and which way you face: click to go there"
        title="Where you are on the planet and which way you face: click to go there"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const map = planetMap(model, change, seen.current)
          const k = (W / map.width) * ZOOM
          const [px, py] = latLonToPixel(at.lat, at.lon, map.width, map.height)
          const x = px + (((e.clientX - rect.left) / rect.width) * W - W / 2) / k
          const y = py + (((e.clientY - rect.top) / rect.height) * H - H / 2) / k
          useEditor.getState().enterGround(pixelToLatLon(((x % map.width) + map.width) % map.width, Math.min(map.height - 1, Math.max(0, y)), map.width, map.height))
        }}
      />
    </div>
  )
}
