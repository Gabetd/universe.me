import { v7 as uuidv7 } from 'uuid'
import { Command, CommandError, handlers, type CommandContext, type HandlerResult } from './commands'
import type { CommandSource } from './schema'
import type { Store } from './store'

export type HistoryAction = 'do' | 'undo' | 'redo'

export interface HistoryRecord {
  action: HistoryAction
  source: CommandSource
  at: string
  command: Command
  inverse: Command
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
    this.ctx = {
      now: () => new Date().toISOString(),
      newId: () => uuidv7(),
      randomSeed: () => Math.floor(Math.random() * 0x100000000),
      ...options.context
    }
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
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
      const handler = handlers[command.type] as (s: Store, p: unknown, c: CommandContext) => HandlerResult
      const result = handler(this.store, command.payload, this.ctx)
      this.options.log?.append({ action, source, at: this.ctx.now(), command, inverse: result.inverse })
      return result
    })
  }

  private finish(action: HistoryAction, command: Command, result: HandlerResult): ExecuteResult {
    const out: ExecuteResult = { action, command, targetId: result.targetId }
    this.options.onChange?.(out)
    return out
  }
}

export { CommandError }
