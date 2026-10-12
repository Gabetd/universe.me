import { DEFAULT_CONTEXT, batchOf } from './command-kit'
import { Command, CommandError, applyCommand, checkSource, type CommandContext, type HandlerResult, type Target } from './commands'
import { Footprint } from './footprint'
import { stepStore } from './step-store'
import type { CommandSource } from './schema'
import type { Store } from './store'
import { SyncMerge, applyMerge, gatherMerge, planMerge, type LoggedMerge, type MergeInput, type MergePlan } from './sync-commands'
import type { SyncRow } from './sync'

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
  /** What it left in the rows it patched: undoing it leaves a field changed since (by someone else) as it is. */
  footprint: Footprint
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

  /**
   * Makes the latest `n` changes one step, to undo and redo together (what a
   * plugin did in one run); they stay as they were applied and logged.
   */
  group(n: number): void {
    if (n < 2 || n > this.undoStack.length) return
    const entries = this.undoStack.splice(-n)
    this.undoStack.push({
      command: batchOf(entries.map((e) => e.command)),
      inverse: batchOf(entries.map((e) => e.inverse).reverse()),
      source: entries.at(-1)!.source,
      footprint: Footprint.of(entries.map((e) => e.footprint))
    })
  }

  /** Validates and applies a command. Throws `CommandError` if it is invalid, or `source` can't send it (`checkSource`). */
  execute(input: unknown, source: CommandSource = 'user'): ExecuteResult {
    const parsed = Command.safeParse(input)
    if (!parsed.success) {
      throw new CommandError(parsed.error.issues.map((i) => `${i.path.join('.') || 'command'}: ${i.message}`).join('; '))
    }
    const command = parsed.data
    checkSource(command, source)
    const footprint = new Footprint()
    const result = this.apply('do', command, source, footprint)
    this.undoStack.push({ command, inverse: result.inverse, source, footprint })
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
    const rows = this.mergeInput(input)
    this.land(rows, planMerge(this.gather(rows)))
  }

  /** Rows from another device as a merge takes them; throws `CommandError` on what isn't. */
  mergeInput(input: unknown): SyncRow[] {
    const parsed = SyncMerge.safeParse(input)
    if (!parsed.success) throw new CommandError(`Rows from another device: ${parsed.error.issues[0]?.message ?? 'not rows'}`)
    return parsed.data.payload.rows
  }

  /** What working out a merge of `rows` needs of this copy (`gatherMerge`): with it, the merge can be worked out elsewhere (`planMerge`, in a worker) and landed here. */
  gather(rows: readonly SyncRow[]): MergeInput[] {
    return gatherMerge(this.store, rows)
  }

  /** Lands a merge as worked out (`planMerge`), as `merge` does: a row changed here since is worked out again. */
  land(rows: readonly SyncRow[], plans: readonly MergePlan[]): void {
    this.store.transaction(() => {
      applyMerge(this.store, rows, plans, this.ctx.now())
      const logged = (rows: { key: string; stamp: string }[]): LoggedMerge => ({ type: 'sync.merge', payload: { rows } })
      this.options.log?.append({ action: 'do', source: 'system', at: this.ctx.now(), command: logged(rows.map(({ key, stamp }) => ({ key, stamp }))), inverse: logged([]) })
    })
  }

  /** Forgets what could be redone (changes taken back for good). */
  clearRedo(): void {
    this.redoStack = []
  }

  undo(): ExecuteResult | undefined {
    const entry = this.undoStack.pop()
    if (!entry) return undefined
    const result = this.apply('undo', entry.inverse, entry.source, entry.footprint)
    // Redoing runs the inverse of the inverse, which for a create is a restore,
    // so the entity keeps its id and history. The footprint now holds what the undo left.
    this.redoStack.push({ ...entry, command: entry.inverse, inverse: result.inverse })
    return this.finish('undo', entry.inverse, result)
  }

  redo(): ExecuteResult | undefined {
    const entry = this.redoStack.pop()
    if (!entry) return undefined
    const result = this.apply('redo', entry.inverse, entry.source, entry.footprint)
    this.undoStack.push({ ...entry, command: entry.inverse, inverse: result.inverse })
    return this.finish('redo', entry.inverse, result)
  }

  private apply(action: HistoryAction, command: Command, source: CommandSource, footprint: Footprint): HandlerResult {
    return this.store.transaction(() => {
      const result = applyCommand(stepStore(this.store, footprint, action), command, this.ctx)
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
