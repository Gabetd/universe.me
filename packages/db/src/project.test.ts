import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Project, ProjectError, SCHEMA_VERSION } from './index'

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
})
