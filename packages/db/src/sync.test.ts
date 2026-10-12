import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyLayer, fromParts, type Command } from '@universe/core'
import { Project } from './index'

let dir: string
const open: Project[] = []
const track = (p: Project) => (open.push(p), p)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'universe-sync-'))
})
afterEach(() => {
  for (const p of open.splice(0)) p.close()
  rmSync(dir, { recursive: true, force: true })
})

/** What `to` asks `from` for, from where it last asked, a page at a time; returns where it got to. */
function pull(from: Project, to: Project, since = 0): number {
  for (;;) {
    const page = from.changesSince(since, { limit: 4, from: to.device })
    to.merge(page.rows)
    since = page.upTo
    if (!page.more) return since
  }
}

/** Everything in a project, as comparable data (terrain as base64: comparing its bytes one by one takes about half a second a face). */
function contents(p: Project) {
  const s = p.snapshot()
  const terrain = s.worlds.map((w) => p.terrain(w.id).height?.map((face) => face && Buffer.from(face).toString('base64')))
  return { nodes: s.nodes, worlds: s.worlds.map((w) => w.settings), regions: s.regions, timeline: s.timeline, terrain }
}

describe('a project between devices', () => {
  it('copies into an empty file, terrain and files included, and both stay the same as each changes', () => {
    const a = track(Project.create(join(dir, 'a.universe'), 'Shared', { device: 'laptop' }))
    const run = (p: Project, type: string, payload: object) => p.bus.execute({ type, payload } as Command)
    const make = (parentId: string, kind: string, name: string) => run(a, 'node.create', { parentId, kind, name }).targetId!
    const world = make(make(make(make(make(a.info().rootId, 'galaxy_cluster', 'Virgo'), 'galaxy', 'Milky Way'), 'star_system', 'Sol'), 'body', 'Terra'), 'world', 'Surface')
    run(a, 'world.update', { id: world, patch: { seaLevel: 0.2 } })
    run(a, 'event.create', { ownerId: world, title: 'Founding', start: fromParts({ year: 1 }) })
    const heights = emptyLayer('height')
    heights[123] = 77
    a.store.transaction(() => a.store.worlds.putLayer(world, 'height', 3, heights))
    run(a, 'asset.add', { id: 'model-1', name: 'tower.glb', mime: 'model/gltf-binary', data: 'AQID' })

    const b = track(Project.create(join(dir, 'b.universe'), 'Shared', { device: 'desktop', copyOf: a.syncId() }))
    const seenA = pull(a, b)
    expect(b.info().rootId).toBe(a.info().rootId)
    expect(b.syncId()).toBe(a.syncId())
    expect(contents(b)).toEqual(contents(a))
    expect(b.store.assets.get('model-1')!.data).toEqual(new Uint8Array([1, 2, 3]))

    // Both change it, then each asks the other for what's new.
    run(a, 'era.create', { ownerId: world, name: 'Dawn', start: 0, end: fromParts({ year: 50 }) })
    run(b, 'region.create', { worldId: world, name: 'North', points: [{ lat: 50, lon: 0 }, { lat: 50, lon: 10 }, { lat: 60, lon: 5 }] })
    pull(a, b, seenA)
    pull(b, a)
    expect(contents(b)).toEqual(contents(a))
    expect(a.snapshot().regions.map((r) => r.name)).toEqual(['North'])
    // Kept on reopening: the stamps are in the file.
    b.close()
    const again = track(Project.open(join(dir, 'b.universe'), { device: 'desktop' }))
    // What this copy wrote itself (the region, and its world's time of change), the rest being the laptop's.
    const own = again.changesSince(0, { from: 'laptop' }).rows
    expect(own.map((r) => JSON.parse(r.key)[0]).sort()).toEqual(['node', 'region'])
    expect(own.every((r) => r.stamp.endsWith('.desktop'))).toBe(true)
  })

  it('keeps the stamps of a row’s fields in the file', () => {
    const path = join(dir, 'a.universe')
    const a = Project.create(path, 'Shared', { device: 'laptop' })
    const id = a.bus.execute({ type: 'node.create', payload: { parentId: a.info().rootId, kind: 'galaxy_cluster', name: 'Virgo' } }).targetId!
    a.bus.execute({ type: 'node.update', payload: { id, patch: { name: 'Virgo II' } } })
    const row = () => a.changesSince(0).rows.find((r) => JSON.parse(r.key)[1] === id)!
    const edited = row()
    // The name changed; the kind, say, is as it was made.
    expect(edited.fields?.['/kind']).toMatch(/\.laptop$/)
    expect(edited.fields?.['/name']).toBeUndefined()
    a.close()
    const again = track(Project.open(path, { device: 'laptop' }))
    expect(again.changesSince(0).rows.find((r) => r.key === edited.key)).toEqual(edited)
  })

  it('keeps two devices’ changes to different fields of one event, and stops sending it once both have both', () => {
    const a = track(Project.create(join(dir, 'a.universe'), 'Shared', { device: 'laptop' }))
    const event = a.bus.execute({ type: 'event.create', payload: { ownerId: a.info().rootId, title: 'Founding', start: fromParts({ year: 1 }) } }).targetId!
    const b = track(Project.create(join(dir, 'b.universe'), 'Shared', { device: 'desktop', copyOf: a.syncId() }))
    let seenA = pull(a, b)
    a.bus.execute({ type: 'event.update', payload: { id: event, patch: { title: 'The Founding' } } })
    b.bus.execute({ type: 'event.update', payload: { id: event, patch: { notes: 'In the rain.' } } })
    const seenB = pull(b, a)
    seenA = pull(a, b, seenA)
    for (const p of [a, b]) expect(p.store.records('event').get(event)).toMatchObject({ title: 'The Founding', notes: 'In the rain.' })
    // The desktop took the laptop's merge whole, with its stamp: neither has anything for the other.
    expect(b.changesSince(seenB, { from: 'laptop' }).rows).toEqual([])
    expect(a.changesSince(seenA, { from: 'desktop' }).rows).toEqual([])
  })

  it('stamps a project made before sync on its first open, so a copy of it gets everything', () => {
    const path = join(dir, 'old.universe')
    const old = Project.create(path, 'Old')
    old.bus.execute({ type: 'node.create', payload: { parentId: old.info().rootId, kind: 'galaxy_cluster', name: 'Virgo' } })
    old.close()
    // As a project from before stamps were kept.
    const db = new DatabaseSync(path)
    db.exec('DELETE FROM row_stamps')
    db.close()

    const reopened = track(Project.open(path, { device: 'laptop' }))
    const copy = track(Project.create(join(dir, 'copy.universe'), 'Old', { device: 'desktop', copyOf: reopened.syncId() }))
    pull(reopened, copy)
    expect(copy.snapshot().nodes.map((n) => n.name)).toEqual(['Old', 'Virgo'])
  })

  it('sends terrain a few faces a page, and logs a merge without what its rows hold', () => {
    const a = track(Project.create(join(dir, 'a.universe'), 'Shared', { device: 'laptop' }))
    const make = (parentId: string, kind: string, name: string) => a.bus.execute({ type: 'node.create', payload: { parentId, kind, name } } as Command).targetId!
    const sol = make(make(make(a.info().rootId, 'galaxy_cluster', 'Virgo'), 'galaxy', 'Milky Way'), 'star_system', 'Sol')
    const worlds = ['Mercury', 'Venus', 'Terra'].map((name) => make(make(sol, 'body', name), 'world', `${name} Surface`))
    a.store.transaction(() => {
      for (const world of worlds) for (let face = 0; face < 6; face++) a.store.worlds.putLayer(world, 'height', face, emptyLayer('height'))
    })
    // 18 faces of ~170 kB as base64 each: a page stops a little past 2 MB, well before its count of rows.
    const page = a.changesSince(0)
    const faces = page.rows.filter((r) => typeof r.data === 'string')
    expect(page.more).toBe(true)
    expect(faces.length).toBeGreaterThan(0)
    expect(faces.length).toBeLessThan(18)
    expect(faces.reduce((n, r) => n + (r.data as string).length, 0)).toBeLessThan(2_500_000)

    const b = track(Project.create(join(dir, 'b.universe'), 'Shared', { device: 'desktop', copyOf: a.syncId() }))
    pull(a, b)
    const logged = new DatabaseSync(join(dir, 'b.universe')).prepare("SELECT length(command) AS n FROM command_log WHERE type = 'sync.merge'").all() as { n: number }[]
    expect(logged.length).toBeGreaterThan(0)
    expect(Math.max(...logged.map((r) => r.n))).toBeLessThan(2000)
  })

  it('keeps what each field was written over and the notes and terrain to merge with, across closing and opening the file', () => {
    const run = (p: Project, type: string, payload: object) => p.bus.execute({ type, payload } as Command)
    const pathA = join(dir, 'a.universe')
    let a = track(Project.create(pathA, 'Shared', { device: 'laptop' }))
    const world = ['galaxy_cluster', 'galaxy', 'star_system', 'body', 'world'].reduce((parentId, kind) => run(a, 'node.create', { parentId, kind, name: kind }).targetId!, a.info().rootId)
    const event = run(a, 'event.create', { ownerId: world, title: 'Founding', start: fromParts({ year: 1 }), notes: '<p>One</p><p>Two</p><p>Three</p>' }).targetId!
    const face = (p: Project, cell: number, value: number) => {
      const bytes = (p.store.worlds.getLayer(world, 'height', 1) ?? emptyLayer('height')).slice()
      bytes[cell] = value
      p.store.transaction(() => p.store.worlds.putLayer(world, 'height', 1, bytes))
    }
    face(a, 1, 10)
    const b = track(Project.create(join(dir, 'b.universe'), 'Shared', { device: 'desktop', copyOf: a.syncId() }))
    const seenA = pull(a, b)
    run(a, 'event.update', { id: event, patch: { notes: '<p>One by A</p><p>Two</p><p>Three</p>' } })
    face(a, 20, 20)
    a.close()
    a = track(Project.open(pathA, { device: 'laptop' }))
    run(b, 'event.update', { id: event, patch: { notes: '<p>One</p><p>Two</p><p>Three by B</p>' } })
    face(b, 40, 30)
    pull(a, b, seenA)
    pull(b, a)
    for (const p of [a, b]) {
      expect(p.snapshot().timeline.events[0]!.notes).toBe('<p>One by A</p><p>Two</p><p>Three by B</p>')
      expect([1, 20, 40].map((i) => p.store.worlds.getLayer(world, 'height', 1)![i])).toEqual([10, 20, 30])
      expect(p.snapshot().timeline.conflicts).toEqual([])
    }
  })
})
