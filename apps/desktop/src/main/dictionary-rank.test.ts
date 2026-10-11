import { describe, expect, it } from 'vitest'
import { editDistance, rank } from './dictionary-rank'

describe('spelling suggestions', () => {
  it('count a swap of two letters as one change', () => {
    expect(editDistance('teh', 'the')).toBe(1)
    expect(editDistance('seige', 'siege')).toBe(1)
    expect(editDistance('seige', 'seize')).toBe(1)
    expect(editDistance('wierd', 'wired')).toBe(1)
    expect(editDistance('cat', 'cart')).toBe(1)
    expect(editDistance('kitten', 'sitting')).toBe(3)
  })
  it('put the closest first, then those made of the same letters', () => {
    // Hunspell's own order for these, as nspell gives it.
    expect(rank('teh', ['ten', 'eh', 'meh', 'tea', 'tech', 'ted', 'tee', 'tel', 'the', 'NEH', 'Te', 'Tet', 'Tex', 'Th'])[0]).toBe('the')
    expect(rank('Seige', ['Seize', 'Sage', 'Beige', 'Sedge', 'Seine', 'Serge', 'Siege']).slice(0, 2)).toEqual(['Siege', 'Seize'])
    expect(rank('wierd', ['weird', 'wield', 'wired'])[0]).toBe('weird')
  })
})
