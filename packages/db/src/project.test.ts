import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, Project, ProjectError, SCHEMA_VERSION } from './index'
import { DEFAULT_WORLD_SETTINGS, TERRAIN_RES, asBytes, bytesToBase64 } from '@universe/core'

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
  it('leaves a file that isn’t a project as it was, and won’t open one with triggers or views', () => {
    const other = join(dir, 'other.db')
    new DatabaseSync(other).exec('CREATE TABLE t (x)')
    const before = readFileSync(other)
    expect(() => Project.open(other)).toThrow(/is not a universe\.me project/)
    // Not switched to WAL, or touched at all.
    expect(readFileSync(other).equals(before)).toBe(true)

    const path = join(dir, 'trap.universe')
    Project.create(path, 'Trap').close()
    new DatabaseSync(path).exec("CREATE TRIGGER t AFTER INSERT ON nodes BEGIN UPDATE nodes SET name = 'owned'; END")
    expect(() => Project.open(path)).toThrow(/triggers or views/)
  })

  it('creates a project with a root universe', () => {
    const p = track(Project.create(join(dir, 'a.universe'), 'Aerth Saga'))
    const info = p.info()
    expect(info).toMatchObject({ name: 'Aerth Saga', schemaVersion: SCHEMA_VERSION })
    expect(p.store.nodes.get(info.rootId)?.kind).toBe('universe')
  })

  it('keeps its name and root across a rename and a reopen', () => {
    const path = join(dir, 'named.universe')
    const p = Project.create(path, 'First')
    const { rootId } = p.info()
    p.setMeta('name', 'Second')
    expect(p.info()).toMatchObject({ name: 'Second', rootId })
    p.close()
    expect(track(Project.open(path)).info()).toMatchObject({ name: 'Second', rootId })
  })

  it('keeps imported files and structures inside the project file, with undo', () => {
    const path = join(dir, 'assets.universe')
    const p = Project.create(path, 'A')
    const bytes = new Uint8Array([103, 108, 84, 70, 2, 0, 0, 0])
    p.bus.execute({ type: 'asset.add', payload: { id: 'model-1', name: 'tower.glb', mime: 'model/gltf-binary', data: bytesToBase64(bytes) } })
    p.bus.execute({ type: 'blueprint.create', payload: { ownerId: p.info().rootId, name: 'Tower', model: { assetId: 'model-1', material: 'stone', heightM: 30 } } })
    p.close()
    const reopened = track(Project.open(path))
    expect(reopened.store.assets.get('model-1')).toMatchObject({ name: 'tower.glb', data: bytes })
    // Each read is its own copy, so changing one can't touch another.
    reopened.store.assets.get('model-1')!.data[0] = 0
    expect(reopened.store.assets.get('model-1')!.data).toEqual(bytes)
    expect(reopened.store.records('blueprint').all().map((b) => b.name)).toEqual(['Tower'])
    // Undoing the import (in the same session) takes the file back out, and redo restores it.
    reopened.bus.execute({ type: 'asset.add', payload: { id: 'model-2', name: 'b.glb', mime: 'model/gltf-binary', data: bytesToBase64(bytes) } })
    reopened.bus.undo()
    expect(reopened.store.assets.get('model-2')).toBeUndefined()
    reopened.bus.redo()
    expect(reopened.store.assets.get('model-2')?.data).toEqual(bytes)
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

  it('saves a copy that opens independently, without blocking commands', async () => {
    const p = track(Project.create(join(dir, 'f.universe'), 'F'))
    const { rootId } = p.info()
    p.bus.execute({ type: 'node.create', payload: { parentId: rootId, kind: 'galaxy_cluster', name: 'Copied' } })
    const copyPath = join(dir, 'f-copy.universe')
    const saving = p.saveCopy(copyPath)
    // The copy is a snapshot from when it started; the project keeps taking commands meanwhile.
    p.bus.execute({ type: 'node.create', payload: { parentId: rootId, kind: 'galaxy_cluster', name: 'Later' } })
    await saving
    expect(readdirSync(dir).sort()).toEqual(['f-copy.universe', 'f.universe', 'f.universe-shm', 'f.universe-wal'])
    const copy = track(Project.open(copyPath))
    expect(copy.store.nodes.all().map((n) => n.name)).toContain('Copied')
    expect(p.store.nodes.all().map((n) => n.name)).toContain('Later')
    await expect(p.saveCopy(copyPath)).rejects.toThrow(ProjectError)
  })

  it('closes while a copy is still being saved', async () => {
    const path = join(dir, 'busy.universe')
    const p = Project.create(path, 'Busy')
    p.bus.execute({ type: 'node.create', payload: { parentId: p.info().rootId, kind: 'galaxy_cluster', name: 'Kept' } })
    const saving = p.saveCopy(join(dir, 'busy-copy.universe'))
    p.close()
    await saving
    for (const file of [path, join(dir, 'busy-copy.universe')]) {
      expect(track(Project.open(file)).store.nodes.all().map((n) => n.name)).toContain('Kept')
    }
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

  it('moves power systems saved by older versions into the universe, pinned to their world', () => {
    const path = join(dir, 'old-powers.universe')
    const db = new DatabaseSync(path)
    for (const m of MIGRATIONS.slice(0, 6)) db.exec(m)
    db.exec('PRAGMA user_version = 6')
    db.exec("INSERT INTO meta VALUES ('format', 'universe.me'), ('name', 'Old')")
    db.exec(`INSERT INTO nodes (id, parent_id, kind, name, seed, created_at, updated_at) VALUES ('root', NULL, 'universe', 'Old', 1, 'x', 'x'), ('w', 'root', 'world', 'W', 1, 'x', 'x')`)
    const old = { id: 'p', ownerId: 'w', name: 'Magic', template: 'magic', color: '#9b7bff', summary: '', aspects: [], values: {}, notes: '', createdAt: 'x', updatedAt: 'x', deletedAt: null }
    db.prepare("INSERT INTO records (kind, id, owner_id, data) VALUES ('power', 'p', 'w', ?)").run(JSON.stringify(old))
    db.close()
    const p = track(Project.open(path))
    expect(p.store.records('power').all()).toEqual([{ ...old, ownerId: 'root', pins: ['w'] }])
    expect(p.store.records('power').byOwner('root')).toHaveLength(1)
  })

  it('fills in world options that settings saved by older versions lack', () => {
    const path = join(dir, 'old-world.universe')
    const p = Project.create(path, 'Old')
    let parent = p.info().rootId
    for (const kind of ['galaxy_cluster', 'galaxy', 'star_system', 'body', 'world']) parent = p.bus.execute({ type: 'node.create', payload: { parentId: parent, kind } }).targetId!
    p.close()
    // Written the way M1 saved it: three terrain options, no seed.
    const raw = new DatabaseSync(path)
    raw.prepare('INSERT INTO worlds (id, settings) VALUES (?, ?)').run(parent, JSON.stringify({ radiusKm: 5000, seaLevel: 10, terrain: { continentScale: 2, roughness: 0.4, mountainHeight: 3000 } }))
    raw.close()
    const q = track(Project.open(path))
    expect(q.store.worlds.getSettings(parent)).toEqual({
      ...DEFAULT_WORLD_SETTINGS,
      radiusKm: 5000,
      seaLevel: 10,
      terrain: { ...DEFAULT_WORLD_SETTINGS.terrain, continentScale: 2, roughness: 0.4, mountainHeight: 3000 }
    })
  })
})
