import { useEffect, useRef } from 'react'
import type { BlendThumbnail } from '../media/blend'

/** A .blend file's saved thumbnail, drawn from its pixels. */
export function Thumbnail({ picture, label, className }: { picture: BlendThumbnail; label: string; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    c.width = picture.width
    c.height = picture.height
    c.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(picture.rgba), picture.width, picture.height), 0, 0)
  }, [picture])
  return <canvas ref={canvas} className={className} role="img" aria-label={label} />
}
