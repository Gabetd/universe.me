import { nameIn, type Language, type LatLon } from '@universe/core'
import { waterwayPlace, type Lake, type River } from './hydrology'

/**
 * A world's rivers and lakes named in the languages spoken where they are
 * (core languages.ts): a river by its rule where its middle runs, a lake
 * where its deepest point lies. Where none is spoken, each keeps the name
 * it was made with. The same water and the same languages give the same
 * names, so the app and the API agree.
 */
export function namedWater<W extends { rivers: River[]; lakes: Lake[] }>(water: W, languageAt: (p: LatLon) => Language | undefined): W {
  const rename = <T extends River | Lake>(w: T, kind: 'river' | 'lake'): T => {
    const language = languageAt(waterwayPlace(w))
    return language ? { ...w, name: nameIn(language, kind, w.id) } : w
  }
  return { ...water, rivers: water.rivers.map((r) => rename(r, 'river')), lakes: water.lakes.map((l) => rename(l, 'lake')) }
}
