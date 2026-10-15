/// <reference lib="webworker" />
import { buildRingGround, type RingGround, type RingGroundInput } from '@universe/procgen'
import { answerCalls } from '../workerCalls'

// The rings of ground beyond the chunks are tens of thousands of points of hills, colours and trees each, built again as the view moves: here, off the UI thread.
answerCalls<RingGroundInput, RingGround>((input) => {
  const ring = buildRingGround(input)
  return { reply: ring, transfer: [ring.positions, ring.colors, ring.indices, ...(ring.normals ? [ring.normals] : []), ...Object.values(ring.trees)].map((a) => a.buffer) }
})
