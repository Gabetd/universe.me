import { z } from 'zod'
import type { ApiHost, WriteOutcome } from './host'
import type { ProjectModels } from './model'

/** What every operation runs with: the host, and what's worked out from its project. */
export interface ApiContext {
  host: ApiHost
  models: ProjectModels
}

/**
 * One thing the API can do (PLAN.md §6): served as a REST route and as an MCP
 * tool from this one definition, so the two never drift apart.
 */
export interface Operation<S extends z.ZodObject = z.ZodObject> {
  /** The MCP tool's name (snake_case). */
  name: string
  /** One line for people, as in a tool list. */
  title: string
  /** What it does and returns, for the AI deciding whether to call it. */
  description: string
  input: S
  /**
   * The REST route. Reads are GETs (inputs from the path and query string),
   * writes POSTs (inputs from the path and a JSON body); `:name` in the path
   * is the input field of that name.
   */
  route: { method: 'GET' | 'POST'; path: string }
  /** Changes the project (and so goes through review mode and undo). */
  write?: boolean
  /** It can delete or overwrite things (MCP's destructiveHint). */
  destructive?: boolean
  run(ctx: ApiContext, input: z.infer<S>): unknown
}

/** An operation, with its input's type checked against `run`. */
export const operation = <S extends z.ZodObject>(op: Operation<S>): Operation => op as unknown as Operation

/** A date in the world's calendar, as clients write it. */
export const When = z
  .union([z.string().min(1), z.number()])
  .describe('A date in the world’s calendar: "1204", "15 Mar 1204", "c. 1200", "13th century", "4.5 billion years ago", or a year as a number')

/** What a write answers: what it did (or proposed), and the ids it made. */
export function written(outcome: WriteOutcome, summary: string, ids: Record<string, string> = {}): Record<string, unknown> {
  return outcome.status === 'applied'
    ? { status: 'applied', summary, ...ids }
    : { status: 'proposed', summary, proposalId: outcome.proposalId, note: 'Review mode is on: this waits for the user to accept it in Universe. The ids are what it will have once accepted; until then nothing can refer to them.', ...ids }
}

/** A query-string flag or number: GET inputs arrive as text. */
export const QueryNumber = z.coerce.number()
export const QueryList = z.union([z.array(z.string()), z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))])
