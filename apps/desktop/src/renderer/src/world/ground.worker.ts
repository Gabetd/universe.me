/// <reference lib="webworker" />
import { buildGroundChunk, type GroundChunk, type GroundChunkInput } from '@universe/procgen'

export interface ChunkRequest {
  id: number
  input: GroundChunkInput
}

// A chunk takes a few milliseconds to build, and a view needs 25 of them, so they're built here.
self.onmessage = (e: MessageEvent<ChunkRequest>) => {
  const chunk: GroundChunk = buildGroundChunk(e.data.input)
  const buffers = [chunk.positions, chunk.colors, chunk.indices, ...Object.values(chunk.plants)].map((a) => a.buffer)
  ;(self as unknown as Worker).postMessage({ id: e.data.id, chunk }, buffers)
}
