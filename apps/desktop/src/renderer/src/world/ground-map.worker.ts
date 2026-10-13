/// <reference lib="webworker" />
import { buildGroundMap, type GroundMapInput } from '@universe/procgen'
import { answerCalls } from '../workerCalls'

// The minimap's picture of the ground is some forty thousand heights and colours, drawn again as the view moves on: here, off the UI thread.
answerCalls<GroundMapInput, Uint8ClampedArray>((input) => {
  const pixels = buildGroundMap(input)
  return { reply: pixels, transfer: [pixels.buffer] }
})
