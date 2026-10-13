/// <reference lib="webworker" />
import { buildFarGround, buildHorizonGround, type FarGroundInput, type GroundSheet, type HorizonGroundInput } from '@universe/procgen'
import { answerCalls } from '../workerCalls'

/** What's asked of the worker: the distant ground, or the land beyond it to the horizon. */
export type DistanceInput = ({ kind: 'far' } & FarGroundInput) | ({ kind: 'horizon' } & HorizonGroundInput)

// The distant ground and the horizon are some ten thousand vertices of hills and colours each, built again as the view moves: here, off the UI thread.
answerCalls<DistanceInput, GroundSheet>((input) => {
  const sheet = input.kind === 'far' ? buildFarGround(input) : buildHorizonGround(input)
  return { reply: sheet, transfer: [sheet.positions, sheet.colors, sheet.indices, ...(sheet.normals ? [sheet.normals] : [])].map((a) => a.buffer) }
})
