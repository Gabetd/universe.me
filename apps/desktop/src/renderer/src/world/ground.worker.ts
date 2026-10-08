/// <reference lib="webworker" />
import { buildGroundChunk, type GroundChunk, type GroundChunkInput } from '@universe/procgen'
import { answerCalls } from '../workerCalls'

// A chunk takes a few milliseconds to build, and a view needs 25 of them, so they're built here.
answerCalls<GroundChunkInput, GroundChunk>((input) => {
  const chunk = buildGroundChunk(input)
  return { reply: chunk, transfer: [chunk.positions, chunk.colors, chunk.indices, ...Object.values(chunk.plants)].map((a) => a.buffer) }
})
