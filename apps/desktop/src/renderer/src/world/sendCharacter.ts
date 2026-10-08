import { characterAt, walkingTime, type LatLon } from '@universe/core'
import { useUi } from '../store'

/**
 * Sends a character to `to`, arriving at `at`: they set out on foot from
 * wherever they are then, early enough to get there in time (or as soon as
 * they reached their last stop, if that's later).
 */
export function sendCharacter(characterId: string, to: LatLon, at: number, eventId: string | null = null) {
  const { timeline, worlds, execute } = useUi.getState()
  const character = timeline.characters.find((c) => c.id === characterId)
  if (!character) return
  const radiusKm = worlds.find((w) => w.id === character.ownerId)?.settings.radiusKm ?? 6371
  const earlier = character.stops.filter((s) => s.at < at)
  const from = earlier.length ? characterAt({ ...character, stops: earlier }, at) : undefined
  const lastArrival = earlier.at(-1)?.at ?? at
  const travel = from ? Math.min(walkingTime(from, to, radiusKm), at - lastArrival) : 0
  return execute({ type: 'character.travel', payload: { id: characterId, stop: { at, ...to, travel, eventId } } })
}
