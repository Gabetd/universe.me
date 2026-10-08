import { z } from 'zod'
import { Id, RecordMeta } from './schema'
import { HexColor } from './world'

/**
 * Species and the food web (PLAN.md §4.2, §7): what lives on a world, in which
 * biomes, and who eats whom. Biomes are the ids of packages/procgen's BIOMES.
 */

export const SPECIES_KINDS = ['flora', 'fauna', 'fungi', 'other'] as const
export const SpeciesKind = z.enum(SPECIES_KINDS)
export type SpeciesKind = z.infer<typeof SpeciesKind>

/** Where it sits in the food web; producers make their own food, decomposers live off the dead. */
export const DIETS = ['producer', 'herbivore', 'omnivore', 'carnivore', 'decomposer'] as const
export const Diet = z.enum(DIETS)
export type Diet = z.infer<typeof Diet>

export const Species = z.object({
  ...RecordMeta,
  name: z.string().min(1).max(200),
  kind: SpeciesKind,
  diet: Diet,
  /** Biome ids it lives in. */
  biomes: z.array(z.number().int().min(1).max(255)),
  color: HexColor,
  notes: z.string(),
  tags: z.array(z.string())
})
export type Species = z.infer<typeof Species>

export const ECO_LINK_TYPES = ['eats', 'pollinates', 'symbiosis', 'competes'] as const
export const EcoLinkType = z.enum(ECO_LINK_TYPES)
export type EcoLinkType = z.infer<typeof EcoLinkType>

/** `fromId` eats (pollinates, lives with, competes with) `toId`. */
export const EcoLink = z.object({
  ...RecordMeta,
  fromId: Id,
  toId: Id,
  type: EcoLinkType
})
export type EcoLink = z.infer<typeof EcoLink>

/** Food-web problems worth a warning: predators with no prey where they live, prey that never shares a biome with its predator. */
export function ecosystemWarnings(species: Species[], links: EcoLink[]): { message: string; ids: string[] }[] {
  const byId = new Map(species.map((s) => [s.id, s]))
  const out: { message: string; ids: string[] }[] = []
  for (const l of links) {
    const a = byId.get(l.fromId)
    const b = byId.get(l.toId)
    if (!a || !b || l.type !== 'eats') continue
    if (a.biomes.length && b.biomes.length && !a.biomes.some((x) => b.biomes.includes(x))) {
      out.push({ message: `${a.name} eats ${b.name}, but they never live in the same biome`, ids: [a.id, b.id] })
    }
    if (a.diet === 'herbivore' && b.kind === 'fauna') out.push({ message: `${a.name} is a herbivore but eats ${b.name}, an animal`, ids: [a.id, b.id] })
  }
  for (const s of species) {
    if (s.diet !== 'carnivore' && s.diet !== 'herbivore' && s.diet !== 'omnivore') continue
    if (!links.some((l) => l.type === 'eats' && l.fromId === s.id)) out.push({ message: `${s.name} eats nothing on this world yet`, ids: [s.id] })
  }
  return out
}
