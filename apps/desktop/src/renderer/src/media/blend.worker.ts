/// <reference lib="webworker" />
import { answerCalls } from '../workerCalls'
import { blendThumbnail, readBlend, type BlendScene, type BlendThumbnail } from './blend'

export type BlendRequest = { bytes: Uint8Array; what: 'thumbnail' | 'scene' }
export type BlendReply = BlendThumbnail | BlendScene | null

// A scene's meshes can run to millions of triangles: read here, not in the window, and handed over rather than copied.
answerCalls<BlendRequest, BlendReply>(({ bytes, what }) => {
  if (what === 'thumbnail') {
    const thumbnail = blendThumbnail(bytes)
    return { reply: thumbnail, transfer: thumbnail ? [thumbnail.rgba.buffer] : [] }
  }
  const scene = readBlend(bytes)
  return { reply: scene, transfer: [...scene.meshes.flatMap((m) => [m.positions.buffer, m.indices.buffer]), ...(scene.thumbnail ? [scene.thumbnail.rgba.buffer] : [])] }
})
