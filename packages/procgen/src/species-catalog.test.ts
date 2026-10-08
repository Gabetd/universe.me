import { describe, expect, it } from 'vitest'
describe('species catalogue', async () => {
  const { SPECIES_CATALOG, catalogFor, suggestSpecies } = await import('./index')
  it('only eats what it has, in a biome it shares', () => {
    const byName = new Map(SPECIES_CATALOG.map((s) => [s.name, s]))
    expect(byName.size).toBe(SPECIES_CATALOG.length)
    for (const s of SPECIES_CATALOG) {
      for (const food of s.eats) {
        const prey = byName.get(food)
        expect(prey, `${s.name} eats ${food}`).toBeDefined()
        expect(prey!.biomes.some((b) => s.biomes.includes(b)), `${s.name} meets ${food}`).toBe(true)
      }
    }
    expect(catalogFor([7]).map((s) => s.name)).toContain('Camel')
  })

  it('suggests what a world lacks, linked to what it already has', () => {
    let n = 0
    const grass = { id: 'g', name: 'Meadow grass' } as never
    const commands = suggestSpecies('w', [5], [grass], [], () => `new-${++n}`)
    const created = commands.filter((c) => c.type === 'species.create').map((c) => (c.payload as { name: string }).name)
    expect(created).not.toContain('Meadow grass')
    expect(created).toContain('Bison')
    expect(commands).toContainEqual({ type: 'ecolink.create', payload: { fromId: expect.stringMatching(/^new-/), toId: 'g', type: 'eats' } })
  })
})
