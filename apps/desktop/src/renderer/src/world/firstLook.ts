import { sphericalMean, type LatLon } from '@universe/core'
import { useUi } from '../store'
import { useEditor } from './editorStore'

/**
 * Where the views look on a world with nothing selected to look at: where
 * they last looked, else the middle of its regions and structures (where its
 * story is, wherever on the planet that is); nowhere in particular on an
 * empty world.
 */
export function firstLook(worldId: string): LatLon | undefined {
  const { lookingAt } = useEditor.getState()
  if (lookingAt) return lookingAt
  const { regions, timeline } = useUi.getState()
  const points: LatLon[] = [...regions.filter((r) => r.worldId === worldId).flatMap((r) => r.points), ...timeline.structures.filter((s) => s.ownerId === worldId)]
  return points.length ? sphericalMean(points) : undefined
}
