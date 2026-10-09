import { DEFAULT_CONTEXT } from './command-kit'
import { Command, CommandError, applyCommand, type CommandContext, type HandlerResult, type Target } from './commands'
import type { CommandSource } from './schema'
import type { Store } from './store'
import { SyncMerge, mergeRows, type LoggedMerge } from './sync-commands'

export type HistoryAction = 'do' | 'undo' | 'redo'

/** What the log holds: a command, or which rows a merge from another device brought. */
export type LoggedCommand = Command | LoggedMerge

export interface HistoryRecord {
  action: HistoryAction
  source: CommandSource
  at: string
  command: LoggedCommand
  inverse: LoggedCommand
}

/** Durable audit log of every applied command; `packages/db` writes it to SQLite. */
export interface HistoryLog {
  append(record: HistoryRecord): void
}

export interface CommandBusOptions {
  log?: HistoryLog
  context?: Partial<CommandContext>
  /** Undo depth kept in memory. */
  maxHistory?: number
  onChange?: (result: ExecuteResult) => void
}

export interface ExecuteResult {
  action: HistoryAction
  command: Command
  target?: Target
  /** Shorthand for `target.id`. */
  targetId?: string
}

interface Entry {
  command: Command
  inverse: Command
  source: CommandSource
}

export class CommandBus {
  private undoStack: Entry[] = []
  private redoStack: Entry[] = []
  private readonly ctx: CommandContext

  constructor(
    private readonly store: Store,
    private readonly options: CommandBusOptions = {}
  ) {
    this.ctx = { ...DEFAULT_CONTEXT, ...options.context }
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** How many of the latest changes, one after another, came from `source`: what undoing "the AI's changes" would take back. */
  latestFrom(source: CommandSource): number {
    let n = 0
    while (n < this.undoStack.length && this.undoStack[this.undoStack.length - 1 - n]!.source === source) n++
    return n
  }

  /** Validates and applies a command. Throws `CommandError` if it is invalid. */
  execute(input: unknown, source: CommandSource = 'user'): ExecuteResult {
    const parsed = Command.safeParse(input)
    if (!parsed.success) {
      throw new CommandError(parsed.error.issues.map((i) => `${i.path.join('.') || 'command'}: ${i.message}`).join('; '))
    }
    const command = parsed.data
    const result = this.apply('do', command, source)
    this.undoStack.push({ command, inverse: result.inverse, source })
    if (this.undoStack.length > (this.options.maxHistory ?? 500)) this.undoStack.shift()
    this.redoStack = []
    return this.finish('do', command, result)
  }

  /**
   * Applies rows from another device (PLAN.md §6.7), checked like any write
   * and logged, but not undone with this device's changes (which stay on the
   * undo stack around it), and not told to `onChange`: it's not a change made
   * here.
   */
  merge(input: unknown): void {
    const parsed = SyncMerge.safeParse(input)
    if (!parsed.success) throw new CommandError(`Rows from another device: ${parsed.error.issues[0]?.message ?? 'not rows'}`)
    const { rows } = parsed.data.payload
    this.store.transaction(() => {
      mergeRows(this.store, rows)
      const logged = (rows: { key: string; stamp: string }[]): LoggedMerge => ({ type: 'sync.merge', payload: { rows } })
      this.options.log?.append({ action: 'do', source: 'system', at: this.ctx.now(), command: logged(rows.map(({ key, stamp }) => ({ key, stamp }))), inverse: logged([]) })
    })
  }

  undo(): ExecuteResult | undefined {
    const entry = this.undoStack.pop()
    if (!entry) return undefined
    const result = this.apply('undo', entry.inverse, entry.source)
    // Redoing runs the inverse of the inverse, which for a create is a restore,
    // so the entity keeps its id and history.
    this.redoStack.push({ command: entry.inverse, inverse: result.inverse, source: entry.source })
    return this.finish('undo', entry.inverse, result)
  }

  redo(): ExecuteResult | undefined {
    const entry = this.redoStack.pop()
    if (!entry) return undefined
    const result = this.apply('redo', entry.inverse, entry.source)
    this.undoStack.push({ command: entry.inverse, inverse: result.inverse, source: entry.source })
    return this.finish('redo', entry.inverse, result)
  }

  private apply(action: HistoryAction, command: Command, source: CommandSource): HandlerResult {
    return this.store.transaction(() => {
      const result = applyCommand(this.store, command, this.ctx)
      if (result.owner) {
        const owner = this.store.nodes.get(result.owner)
        if (owner) this.store.nodes.update({ ...owner, updatedAt: this.ctx.now() })
      }
      this.options.log?.append({ action, source, at: this.ctx.now(), command, inverse: result.inverse })
      return result
    })
  }

  private finish(action: HistoryAction, command: Command, result: HandlerResult): ExecuteResult {
    const out: ExecuteResult = { action, command, target: result.target, targetId: result.target?.id }
    this.options.onChange?.(out)
    return out
  }
}

export { CommandError }
