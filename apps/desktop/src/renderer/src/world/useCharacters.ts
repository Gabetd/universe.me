import { characterAt, type Character, type CharacterPlace } from '@universe/core'
import { useMemo } from 'react'
import { useUi } from '../store'
import { usePlayhead } from '../timeline/timelineStore'

/** A character as drawn at the playhead. */
export interface PlacedCharacter {
  character: Character
  place: CharacterPlace
  selected: boolean
}

/** The world's characters alive at the playhead, where they are then. */
export function useCharactersAt(worldId: string): PlacedCharacter[] {
  const all = useUi((s) => s.timeline.characters)
  const selectedId = useUi((s) => s.selectedCharacterId)
  const playhead = usePlayhead(worldId)
  return useMemo(
    () =>
      all.flatMap((character) => {
        if (character.ownerId !== worldId) return []
        const place = characterAt(character, playhead)
        return place ? [{ character, place, selected: character.id === selectedId }] : []
      }),
    [all, worldId, playhead, selectedId]
  )
}
