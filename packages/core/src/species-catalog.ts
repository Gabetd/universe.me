import type { Diet, SpeciesKind } from './ecosystem'

/**
 * Species to suggest for a world, by the biomes it has (packages/procgen's
 * BIOMES ids), with who eats whom. Ordinary Earth-like life, so a world gets
 * a working food web to rename and change rather than an empty page.
 */
export interface CatalogSpecies {
  name: string
  kind: SpeciesKind
  diet: Diet
  color: string
  biomes: number[]
  /** Names of what it eats, among the catalogue. */
  eats: string[]
}

const ICE = 1
const TUNDRA = 2
const TAIGA = 3
const FOREST = 4
const GRASSLAND = 5
const SHRUBLAND = 6
const DESERT = 7
const SAVANNA = 8
const RAINFOREST = 9
const SWAMP = 10
const ROCK = 11
const BEACH = 12

const flora = (name: string, color: string, biomes: number[]): CatalogSpecies => ({ name, kind: 'flora', diet: 'producer', color, biomes, eats: [] })
const fauna = (name: string, diet: Diet, color: string, biomes: number[], eats: string[]): CatalogSpecies => ({ name, kind: 'fauna', diet, color, biomes, eats })

export const SPECIES_CATALOG: CatalogSpecies[] = [
  flora('Lichen', '#a7b59a', [ICE, TUNDRA, ROCK]),
  flora('Cottongrass', '#c9d3a1', [TUNDRA, SWAMP]),
  flora('Spruce', '#2f5b44', [TAIGA]),
  flora('Blueberry', '#4f6fa8', [TAIGA, FOREST]),
  flora('Oak', '#4b7a35', [FOREST]),
  flora('Bracken', '#7d9a3d', [FOREST, SHRUBLAND]),
  flora('Meadow grass', '#94b65a', [GRASSLAND, SAVANNA]),
  flora('Wildflowers', '#e0a8c8', [GRASSLAND]),
  flora('Sagebrush', '#a9a066', [SHRUBLAND, DESERT]),
  flora('Cactus', '#5b8a4a', [DESERT]),
  flora('Acacia', '#8e9c4a', [SAVANNA]),
  flora('Fig tree', '#2d7a34', [RAINFOREST]),
  flora('Orchid', '#c77dd6', [RAINFOREST]),
  flora('Reeds', '#9a9a58', [SWAMP, BEACH]),
  flora('Mangrove', '#3e6e4e', [SWAMP, BEACH]),
  flora('Mountain moss', '#6f8a5a', [ROCK, TUNDRA]),
  { name: 'Mushrooms', kind: 'fungi', diet: 'decomposer', color: '#c2a37a', biomes: [FOREST, TAIGA, RAINFOREST, SWAMP], eats: [] },

  fauna('Bee', 'herbivore', '#e5b93a', [GRASSLAND, FOREST, SHRUBLAND, SAVANNA, SWAMP, RAINFOREST], ['Wildflowers', 'Orchid']),
  fauna('Reindeer', 'herbivore', '#9a8670', [TUNDRA, TAIGA], ['Lichen', 'Cottongrass']),
  fauna('Arctic hare', 'herbivore', '#e8e6df', [TUNDRA, ICE], ['Lichen', 'Cottongrass']),
  fauna('Moose', 'herbivore', '#5d4632', [TAIGA, SWAMP], ['Spruce', 'Reeds']),
  fauna('Red deer', 'herbivore', '#8b5a35', [FOREST, GRASSLAND], ['Oak', 'Meadow grass', 'Bracken']),
  fauna('Rabbit', 'herbivore', '#b59a7a', [GRASSLAND, SHRUBLAND, FOREST], ['Meadow grass', 'Wildflowers']),
  fauna('Wild boar', 'omnivore', '#4e3c30', [FOREST, SHRUBLAND], ['Oak', 'Mushrooms', 'Bracken']),
  fauna('Bison', 'herbivore', '#5b4433', [GRASSLAND], ['Meadow grass']),
  fauna('Desert tortoise', 'herbivore', '#8a7a52', [DESERT, SHRUBLAND], ['Cactus', 'Sagebrush']),
  fauna('Camel', 'herbivore', '#c19a6b', [DESERT], ['Cactus', 'Sagebrush']),
  fauna('Zebra', 'herbivore', '#dcdcdc', [SAVANNA], ['Meadow grass']),
  fauna('Giraffe', 'herbivore', '#d7a85b', [SAVANNA], ['Acacia']),
  fauna('Monkey', 'omnivore', '#7a5b3e', [RAINFOREST], ['Fig tree', 'Orchid']),
  fauna('Parrot', 'herbivore', '#3fbf6f', [RAINFOREST], ['Fig tree']),
  fauna('Mountain goat', 'herbivore', '#e9e4d8', [ROCK, TUNDRA], ['Mountain moss', 'Lichen']),
  fauna('Crab', 'omnivore', '#d4643c', [BEACH, SWAMP], ['Mangrove', 'Reeds']),
  fauna('Frog', 'carnivore', '#5a9b3c', [SWAMP, RAINFOREST], ['Bee']),

  fauna('Arctic fox', 'carnivore', '#f1f0ea', [TUNDRA, ICE], ['Arctic hare']),
  fauna('Polar bear', 'carnivore', '#f4f2ea', [ICE], ['Arctic hare']),
  fauna('Wolf', 'carnivore', '#6e6e70', [TAIGA, FOREST, TUNDRA], ['Reindeer', 'Red deer', 'Moose', 'Rabbit']),
  fauna('Brown bear', 'omnivore', '#6b4a2f', [TAIGA, FOREST], ['Blueberry', 'Wild boar', 'Moose']),
  fauna('Fox', 'carnivore', '#c9622f', [FOREST, GRASSLAND, SHRUBLAND], ['Rabbit']),
  fauna('Eagle', 'carnivore', '#5a4632', [ROCK, GRASSLAND, SHRUBLAND, TAIGA, TUNDRA], ['Rabbit', 'Mountain goat', 'Arctic hare']),
  fauna('Coyote', 'carnivore', '#a08260', [DESERT, SHRUBLAND, GRASSLAND], ['Rabbit', 'Desert tortoise']),
  fauna('Lion', 'carnivore', '#c99a4b', [SAVANNA], ['Zebra', 'Giraffe']),
  fauna('Jaguar', 'carnivore', '#c8953e', [RAINFOREST], ['Monkey', 'Parrot', 'Frog']),
  fauna('Crocodile', 'carnivore', '#556b3a', [SWAMP], ['Frog', 'Moose', 'Crab']),
  fauna('Gull', 'omnivore', '#e7e9ec', [BEACH], ['Crab'])
]

/** Catalogue species for these biomes. */
export const catalogFor = (biomes: number[]) => SPECIES_CATALOG.filter((s) => s.biomes.some((b) => biomes.includes(b)))
