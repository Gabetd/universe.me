import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { deflateSync, inflateSync } from 'node:zlib'
import type { Command, CommandSource, HistoryAction, HistoryLog, HistoryRecord } from '@universe/core'

/**
 * Only commands this big are deflated. Smaller ones gain nothing and setting up
 * zlib would double their cost; bigger ones (an imported model's 85 MB of
 * base64) would take longer to deflate than the rest of the import put together.
 */
const DEFLATED = { min: 1024, max: 4 * 1024 * 1024 }

/** JSON, deflated (level 1, like terrain layers) when that's worth it. */
function pack(command: Command): string | Uint8Array {
  const json = JSON.stringify(command)
  // In bytes, as inflating counts them (text beyond ASCII takes up to three each).
  const bytes = Buffer.byteLength(json)
  return bytes < DEFLATED.min || bytes > DEFLATED.max ? json : deflateSync(json, { level: 1 })
}

function unpack(value: string | Uint8Array): Command {
  // Never more than was packed: a bigger one is damaged, or made to inflate into gigabytes.
  return JSON.parse(typeof value === 'string' ? value : inflateSync(value, { maxOutputLength: DEFLATED.max }).toString('utf8')) as Command
}

interface LogRow {
  at: string
  action: HistoryAction
  source: CommandSource
  command: string | Uint8Array
  inverse: string | Uint8Array
}

/**
 * Every applied command, in the `command_log` table. A command and its inverse
 * are kept as deflated JSON blobs, since terrain strokes carry their cells
 * (a 107 KB stroke and its inverse shrank to 35 KB and 0.6 KB). Small and very
 * large commands, and rows from older builds, are JSON text; SQLite keeps each
 * value's own type, so the columns hold both and no migration is needed.
 */
export class SqliteHistoryLog implements HistoryLog {
  private readonly insert: StatementSync
  private readonly select: StatementSync

  constructor(db: DatabaseSync) {
    this.insert = db.prepare('INSERT INTO command_log (at, action, source, type, command, inverse) VALUES (?, ?, ?, ?, ?, ?)')
    this.select = db.prepare('SELECT at, action, source, command, inverse FROM command_log ORDER BY seq')
  }

  append(r: HistoryRecord): void {
    this.insert.run(r.at, r.action, r.source, r.command.type, pack(r.command), pack(r.inverse))
  }

  /** Everything logged, oldest first. */
  entries(): HistoryRecord[] {
    return (this.select.all() as unknown as LogRow[]).map((r) => ({ at: r.at, action: r.action, source: r.source, command: unpack(r.command), inverse: unpack(r.inverse) }))
  }
}
