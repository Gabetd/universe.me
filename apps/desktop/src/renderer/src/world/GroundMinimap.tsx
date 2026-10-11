import type { LatLon } from '@universe/core'
import { latLonToPixel, pixelToLatLon, type TerrainModel } from '@universe/procgen'
import { useEffect, useRef } from 'react'
import { useEditor } from './editorStore'
import { planetMap } from './MapView'
import type { TerrainChange } from './useTerrain'

const W = 220
const H = 110

/**
 * Where you are on the ground, on the whole planet's map, in the corner of
 * the ground view. Clicking it goes down to the ground there.
 */
export function GroundMinimap({ model, change, at }: { model: TerrainModel; change: TerrainChange; at: LatLon }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const seen = useRef<TerrainChange>(undefined)
  useEffect(() => {
    const c = canvas.current?.getContext('2d')
    if (!c) return
    const map = planetMap(model, change, seen.current)
    seen.current = change
    c.drawImage(map, 0, 0, W, H)
    const [x, y] = latLonToPixel(at.lat, at.lon, W, H)
    c.strokeStyle = 'rgba(255,255,255,0.55)'
    c.lineWidth = 1
    c.beginPath()
    c.moveTo(x + 0.5, 0)
    c.lineTo(x + 0.5, H)
    c.moveTo(0, y + 0.5)
    c.lineTo(W, y + 0.5)
    c.stroke()
    c.fillStyle = '#ff5a5a'
    c.strokeStyle = '#fff'
    c.lineWidth = 2
    c.beginPath()
    c.arc(x, y, 4, 0, Math.PI * 2)
    c.fill()
    c.stroke()
  }, [model, change, at])
  // In a box of its own: the view's rules place every canvas in it over the whole view.
  return (
    <div className="ground-minimap">
      <canvas
        ref={canvas}
        width={W}
        height={H}
        data-testid="ground-minimap"
        data-at={`${at.lat.toFixed(4)},${at.lon.toFixed(4)}`}
        aria-label="Where you are on the planet: click to go there"
        title="Where you are on the planet: click to go there"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          useEditor.getState().enterGround(pixelToLatLon(((e.clientX - rect.left) / rect.width) * W, ((e.clientY - rect.top) / rect.height) * H, W, H))
        }}
      />
    </div>
  )
}
