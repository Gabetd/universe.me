import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asBytes, bytesToBase64, type Command } from '@universe/core'
import { SqliteHistoryLog } from './history-log'
import { Project, migrate } from './index'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'universe-log-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const stored = (db: DatabaseSync) =>
  db.prepare('SELECT type, typeof(command) AS kind, length(command) AS bytes FROM command_log ORDER BY seq').all() as { type: string; kind: string; bytes: number }[]

describe('SqliteHistoryLog', () => {
  it('reads back every command it wrote, deflating the ones worth it', () => {
    const path = join(dir, 'log.universe')
    const p = Project.create(path, 'Log')
    const exec = (type: string, payload: object) => p.bus.execute({ type, payload }, 'ai').targetId!
    let parent = p.info().rootId
    for (const kind of ['galaxy_cluster', 'galaxy', 'star_system', 'body', 'world']) parent = exec('node.create', { parentId: parent, kind })
    const cells = new Int16Array(100 * 100).map((_, i) => Math.round(500 * Math.sin(i / 300)))
    const stroke = { worldId: parent, layer: 'height', patches: [{ face: 1, x: 0, y: 0, w: 100, h: 100, data: bytesToBase64(asBytes(cells)) }] }
    exec('terrain.patch', stroke)
    p.bus.undo()
    p.close()

    const db = new DatabaseSync(path)
    const entries = new SqliteHistoryLog(db).entries()
    expect(entries.map((e) => [e.action, e.source, e.command.type])).toEqual([
      ...Array.from({ length: 5 }, () => ['do', 'ai', 'node.create']),
      ['do', 'ai', 'terrain.patch'],
      ['undo', 'ai', 'terrain.patch']
    ])
    expect(entries[5]!.command).toEqual({ type: 'terrain.patch', payload: stroke })
    expect(entries[6]!.command).toEqual(entries[5]!.inverse)
    const rows = stored(db)
    db.close()
    expect(rows.map((r) => r.kind)).toEqual([...Array.from({ length: 5 }, () => 'text'), 'blob', 'blob'])
    // 20 KB of cells is about 27 KB of base64 JSON, which deflates to well under half.
    expect(rows[5]!.bytes).toBeLessThan(JSON.stringify(entries[5]!.command).length / 2)
  })

  it('reads rows older builds wrote as JSON text, next to new ones', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const old: Command = { type: 'node.update', payload: { id: 'a', patch: { name: 'Old' } } }
    db.prepare('INSERT INTO command_log (at, action, source, type, command, inverse) VALUES (?, ?, ?, ?, ?, ?)').run('then', 'do', 'user', old.type, JSON.stringify(old), JSON.stringify(old))
    const log = new SqliteHistoryLog(db)
    const now: Command = { type: 'node.update', payload: { id: 'a', patch: { notes: 'A long note. '.repeat(100) } } }
    log.append({ at: 'now', action: 'redo', source: 'system', command: now, inverse: old })
    expect(log.entries()).toEqual([
      { at: 'then', action: 'do', source: 'user', command: old, inverse: old },
      { at: 'now', action: 'redo', source: 'system', command: now, inverse: old }
    ])
    expect(stored(db).map((r) => r.kind)).toEqual(['text', 'blob'])
    db.close()
  })

  it('keeps a very large command, such as an imported model, as JSON text', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const log = new SqliteHistoryLog(db)
    const big: Command = { type: 'asset.add', payload: { id: 'm', name: 'm.glb', mime: 'model/gltf-binary', data: 'A'.repeat(5 * 1024 * 1024) } }
    log.append({ at: 'now', action: 'do', source: 'user', command: big, inverse: { type: 'asset.remove', payload: { id: 'm' } } })
    expect(log.entries()[0]!.command).toEqual(big)
    expect(stored(db)[0]!.kind).toBe('text')
    db.close()
  })
})
