import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Project } from '@universe/db'
import { dirToFace, generateBase, latLonToDir, nearestCell, readSeed } from '@universe/procgen'
import { afterEach, describe, expect, it } from 'vitest'
import { SAMPLE_PLACES, buildSample } from './sample'

let dir: string | undefined
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

describe('the sample universe', () => {
  it('builds a world with a history to look around in, all of it the app’s own and kept in the file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'universe-sample-'))
    const path = join(dir, 'Sample.universe')
    const made = Project.create(path, 'Sample universe')
    await buildSample(made)
    // Nothing of it is the AI's.
    expect(made.bus.latestFrom('ai')).toBe(0)
    made.close()

    // Opened again, it's all there, and there's nothing to undo.
    const p = Project.open(path)
    try {
      expect(p.bus.canUndo).toBe(false)
      const s = p.snapshot()
      expect(s.nodes.map((n) => n.kind)).toEqual(expect.arrayContaining(['galaxy_cluster', 'galaxy', 'star_system', 'body', 'world']))
      expect(s.worlds[0]!.settings.seedText).toBe('Calder')
      expect(s.regions).toHaveLength(4)
      const t = s.timeline
      expect([t.eras.length, t.events.length, t.links.length, t.groups.length]).toEqual([4, 11, 5, 1])
      expect([t.structures.length, t.characters.length, t.themes.length, t.themeSpans.length]).toEqual([7, 4, 3, 3])
      expect([t.factions.length, t.memberships.length, t.holdings.length, t.relationships.length]).toEqual([4, 4, 3, 4])
      expect([t.lifeforms.length, t.powers.length, t.powerAges.length]).toEqual([5, 1, 2])
      expect(t.effects.length).toBeGreaterThanOrEqual(2)
      // Its present day is after the Thaw.
      expect(t.timelines.find((x) => x.id === s.worlds[0]!.id)?.now).toBeGreaterThan(t.eras.find((e) => e.name === 'The Thaw')!.start)
    } finally {
      p.close()
    }
  })

  it('puts every place on land', () => {
    const w = readSeed('Calder')
    const base = generateBase(w.seed, w.terrain)
    for (const [name, { lat, lon }] of Object.entries(SAMPLE_PLACES)) {
      const d = latLonToDir(lat, lon)
      const f = dirToFace(d[0], d[1], d[2])
      expect(base.height[f.face]![nearestCell(f.s, f.t)], name).toBeGreaterThan(0)
    }
  }, 20_000)
})
