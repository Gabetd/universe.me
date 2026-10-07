import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, Project, ProjectError, SCHEMA_VERSION } from './index'
import { TERRAIN_RES, asBytes, bytesToBase64 } from '@universe/core'

let dir: string
const open: Project[] = []
const track = (p: Project) => (open.push(p), p)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'universe-db-'))
})

afterEach(() => {
  for (const p of open.splice(0)) p.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Project', () => {
  it('creates a project with a root universe', () => {
    const p = track(Project.create(join(dir, 'a.universe'), 'Aerth Saga'))
    const info = p.info()
    expect(info).toMatchObject({ name: 'Aerth Saga', schemaVersion: SCHEMA_VERSION })
    expect(p.store.nodes.get(info.rootId)?.kind).toBe('universe')
  })

  it('persists commands across close and reopen', () => {
    const path = join(dir, 'b.universe')
    const p = Project.create(path, 'B')
    const { rootId } = p.info()
    const id = p.bus.execute({ type: 'node.create', payload: { parentId: rootId, kind: 'galaxy_cluster', name: 'Virgo', tags: ['x'] } }).targetId!
    p.bus.execute({ type: 'node.update', payload: { id, patch: { notes: 'Home cluster', position: { x: 1.5, y: -2, z: 3 } } } })
    p.close()

    const reopened = track(Project.open(path))
    expect(reopened.store.nodes.get(id)).toMatchObject({
      name: 'Virgo',
      notes: 'Home cluster',
      tags: ['x'],
      position: { x: 1.5, y: -2, z: 3 }
    })
  })

  it('undo and redo work against SQLite', () => {
    const p = track(Project.create(join(dir, 'c.universe'), 'C'))
    const { rootId } = p.info()
    p.bus.execute({ type: 'node.create', payload: { parentId: rootId, kind: 'galaxy_cluster' } })
    expect(p.store.nodes.all()).toHaveLength(2)
    p.bus.undo()
    expect(p.store.nodes.all()).toHaveLength(1)
    p.bus.redo()
    expect(p.store.nodes.all()).toHaveLength(2)
  })

  it('rolls back a failed command', () => {
    const p = track(Project.create(join(dir, 'd.universe'), 'D'))
    const { rootId } = p.info()
    expect(() => p.bus.execute({ type: 'node.create', payload: { parentId: rootId, kind: 'world' } })).toThrow()
    expect(p.store.nodes.all()).toHaveLength(1)
  })

  it('writes the command history log', () => {
    const path = join(dir, 'e.universe')
    const p = Project.create(path, 'E')
    p.bus.execute({ type: 'node.create', payload: { parentId: p.info().rootId, kind: 'galaxy_cluster' } }, 'ai')
    p.bus.undo()
    p.close()
    const db = new DatabaseSync(path)
    const rows = db.prepare('SELECT action, source, type FROM command_log ORDER BY seq').all()
    db.close()
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { action: 'do', source: 'ai', type: 'node.create' },
      { action: 'undo', source: 'ai', type: 'node.delete' }
    ])
  })

  it('saves a copy that opens independently', () => {
    const p = track(Project.create(join(dir, 'f.universe'), 'F'))
    p.bus.execute({ type: 'node.create', payload: { parentId: p.info().rootId, kind: 'galaxy_cluster', name: 'Copied' } })
    const copyPath = join(dir, 'f-copy.universe')
    p.saveCopy(copyPath)
    const copy = track(Project.open(copyPath))
    expect(copy.store.nodes.all().map((n) => n.name)).toContain('Copied')
  })

  it('refuses to overwrite and rejects non-projects', () => {
    const path = join(dir, 'g.universe')
    track(Project.create(path, 'G'))
    expect(() => Project.create(path, 'G')).toThrow(ProjectError)

    const junk = join(dir, 'junk.universe')
    writeFileSync(junk, 'not a database')
    expect(() => Project.open(junk)).toThrow(ProjectError)

    const other = join(dir, 'other.universe')
    new DatabaseSync(other).close()
    expect(() => Project.open(other)).toThrow(/not a universe.me project/)
  })

  it('refuses projects from a newer schema', () => {
    const path = join(dir, 'h.universe')
    Project.create(path, 'H').close()
    const db = new DatabaseSync(path)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    db.close()
    expect(() => Project.open(path)).toThrow(/newer version/)
  })

  it('persists world settings, compressed terrain layers and regions', () => {
    const path = join(dir, 'w.universe')
    const p = Project.create(path, 'W')
    const exec = (type: string, payload: object) => p.bus.execute({ type, payload }).targetId!
    let parent = p.info().rootId
    for (const kind of ['galaxy_cluster', 'galaxy', 'star_system', 'body']) parent = exec('node.create', { parentId: parent, kind })
    const worldId = exec('node.create', { parentId: parent, kind: 'world' })
    exec('world.update', { id: worldId, patch: { seaLevel: 250 } })
    exec('terrain.patch', {
      worldId,
      layer: 'height',
      patches: [{ face: 2, x: 10, y: 20, w: 2, h: 1, data: bytesToBase64(asBytes(new Int16Array([-1200, 3400]))) }]
    })
    const regionId = exec('region.create', { worldId, name: 'Shire', points: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }, { lat: 5, lon: 1 }] })
    p.close()

    const q = track(Project.open(path))
    expect(q.store.worlds.getSettings(worldId)?.seaLevel).toBe(250)
    expect(q.store.worlds.terrainRevision(worldId)).toBe(1)
    const face = new Int16Array(q.store.worlds.getLayer(worldId, 'height', 2)!.buffer)
    expect([face[20 * TERRAIN_RES + 10], face[20 * TERRAIN_RES + 11]]).toEqual([-1200, 3400])
    expect(q.store.worlds.getLayer(worldId, 'height', 3)).toBeUndefined()
    expect(q.store.regions.get(regionId)).toMatchObject({ name: 'Shire', points: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }, { lat: 5, lon: 1 }] })
  })

  it('persists timeline records and rolls them back with a failed command', () => {
    const path = join(dir, 't.universe')
    const p = Project.create(path, 'T')
    const root = p.info().rootId
    const exec = (type: string, payload: object) => p.bus.execute({ type, payload }).targetId!
    const a = exec('event.create', { ownerId: root, title: 'Big Bang', start: -4.35e17, end: null })
    const b = exec('event.create', { ownerId: root, title: 'First stars', start: -4.3e17 })
    exec('link.create', { fromId: a, toId: b })
    exec('era.create', { ownerId: root, name: 'Dark Ages', start: -4.35e17, end: -4.3e17 })
    expect(() => p.bus.execute({ type: 'batch', payload: { commands: [{ type: 'event.delete', payload: { id: b } }, { type: 'event.delete', payload: { id: 'nope' } }] } })).toThrow()
    p.close()

    const q = track(Project.open(path))
    expect(q.store.records('event').all().map((e) => e.title)).toEqual(['Big Bang', 'First stars'])
    expect(q.store.records('link').all()).toEqual([expect.objectContaining({ fromId: a, toId: b, type: 'causes' })])
    expect(q.store.records('era').all()[0]).toMatchObject({ name: 'Dark Ages' })
    q.bus.execute({ type: 'event.delete', payload: { id: a } })
    expect(q.store.records('link').all()).toEqual([])
    expect(q.store.records('event').get(a)?.deletedAt).not.toBeNull()
  })

  it('upgrades a project created by an older schema', () => {
    const path = join(dir, 'old.universe')
    const db = new DatabaseSync(path)
    db.exec(MIGRATIONS[0]!)
    db.exec('PRAGMA user_version = 1')
    db.exec("INSERT INTO meta VALUES ('format', 'universe.me'), ('name', 'Old')")
    db.exec(`INSERT INTO nodes (id, parent_id, kind, name, seed, created_at, updated_at) VALUES ('root', NULL, 'universe', 'Old', 1, 'x', 'x')`)
    db.close()
    const p = track(Project.open(path))
    expect(p.info()).toMatchObject({ name: 'Old', schemaVersion: SCHEMA_VERSION })
    expect(p.store.regions.all()).toEqual([])
    expect(p.store.records('event').all()).toEqual([])
  })
})
