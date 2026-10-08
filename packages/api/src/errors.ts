import { CommandError } from '@universe/core'
import { ZodError, z } from 'zod'
import { ApiError } from './host'

/** The HTTP status for an error: the API's own, 400 for an invalid input or command, 500 for anything else. */
export function errorStatus(err: unknown): number {
  if (err instanceof ApiError) return err.status
  if (err instanceof CommandError || err instanceof ZodError) return 400
  return 500
}

/** What went wrong, in words a client (or a model) can act on. */
export function errorMessage(err: unknown): string {
  if (err instanceof ZodError) return `Invalid input: ${z.prettifyError(err)}`
  return err instanceof Error ? err.message : String(err)
}
