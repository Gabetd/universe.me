/// <reference lib="webworker" />
import { galaxyGlowPixels, type GalaxyShape } from '@universe/procgen'
import { answerCalls } from '../workerCalls'

export interface GlowRequest {
  shape: GalaxyShape
  seed: number
  size: number
  count: number
}

// A sharp glow scatters tens of thousands of stars (a few hundred ms), so it's made here.
answerCalls<GlowRequest, Uint8ClampedArray<ArrayBuffer>>(({ shape, seed, size, count }) => {
  const pixels = galaxyGlowPixels(shape, seed, size, count)
  return { reply: pixels, transfer: [pixels.buffer] }
})
