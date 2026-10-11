/// <reference lib="webworker" />
import { buildFarGround, type FarGroundInput, type GroundSheet } from '@universe/procgen'
import { answerCalls } from '../workerCalls'

// The distant ground is some ten thousand vertices of hills and colours, built again as the view moves a chunk: here, off the UI thread.
answerCalls<FarGroundInput, GroundSheet>((input) => {
  const sheet = buildFarGround(input)
  return { reply: sheet, transfer: [sheet.positions.buffer, sheet.colors.buffer, sheet.indices.buffer] }
})
