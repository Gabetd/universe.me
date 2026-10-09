import { z } from 'zod'
import type { HandlerMap } from './commands'
import { Finding, FindingRef } from './findings'
import { NewId, create, recordCrud } from './record-kit'
import { Id } from './schema'

const FindingFields = Finding.pick({ severity: true, title: true, explanation: true, suggestion: true, refs: true, status: true, reporter: true, note: true })
export type FindingPatch = Partial<z.infer<typeof FindingFields>>

const finding = recordCrud('finding', FindingFields)

export const FINDING_COMMANDS = [
  /** Something inconsistent on a world (its owner), open until resolved or dismissed. */
  z.object({
    type: z.literal('finding.create'),
    payload: FindingFields.partial().extend({ ...NewId, ownerId: Id, severity: Finding.shape.severity, title: Finding.shape.title, refs: z.array(FindingRef).max(20).optional() })
  }),
  ...finding.commands
] as const

type FindingCommand = z.infer<(typeof FINDING_COMMANDS)[number]>

export const findingHandlers: HandlerMap<FindingCommand> = {
  'finding.create': (store, { id, ownerId, ...p }, ctx) =>
    create(store, 'finding', ctx, ownerId, id, {
      severity: p.severity,
      title: p.title,
      explanation: p.explanation ?? '',
      suggestion: p.suggestion ?? '',
      refs: p.refs ?? [],
      status: p.status ?? 'open',
      reporter: p.reporter ?? '',
      note: p.note ?? ''
    }),
  'finding.update': finding.update,
  'finding.delete': finding.delete
}
