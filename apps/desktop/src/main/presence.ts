import { Login, Name } from '@universe/core'
import { z } from 'zod'
import type { PersonIn, Where as WhereValue } from '../shared/api'

/**
 * Who's in a universe and where (PLAN.md §6.7, with other people): each
 * device keeps what it has heard, from the people visiting it and from the
 * devices it visits, and passes it on in its hello, so two people visiting a
 * third see each other. Someone counts as in for half a minute after they
 * were last heard from.
 */

/** How long someone counts as in after they were last heard from. */
export const PRESENCE_MS = 30_000
/** People passed on in one hello, at most. */
export const MAX_PEOPLE = 200

/** Where someone is, as the window says it. */
export const Where = z.object({ nodeId: z.string().max(200).nullable(), view: z.string().max(40), label: z.string().max(200) }) satisfies z.ZodType<WhereValue>
export type Where = z.infer<typeof Where>

/** Someone in a universe as a hello carries them: who, where, and how long ago they were heard from (not when: two computers' clocks differ). */
export const PresenceWire = z.object({ login: Login, name: Name, where: Where.nullable(), age: z.number().min(0) })
export type PresenceWire = z.infer<typeof PresenceWire>

interface Heard {
  person: PersonIn
  /** When it was heard, by this computer's clock. */
  at: number
}

export class Presences {
  /** By universe (its sync id), then by login. */
  private readonly heard = new Map<string, Map<string, Heard>>()

  /** What was heard of the people in a universe; the newest word of each person stays, and `skip` (this computer's own person) is never kept. */
  hear(syncId: string, people: readonly PresenceWire[], skip: string | undefined, now = Date.now()): void {
    let book = this.heard.get(syncId)
    for (const { login, name, where, age } of people) {
      if (login === skip || age >= PRESENCE_MS) continue
      const at = now - age
      if (!book) this.heard.set(syncId, (book = new Map()))
      if ((book.get(login)?.at ?? -Infinity) < at) book.set(login, { person: { login, name, where }, at })
    }
  }

  /** Who's in a universe now, but `skip` (someone's own entry never goes back to them). */
  in(syncId: string, skip: string | undefined, now = Date.now()): PersonIn[] {
    return this.fresh(syncId, skip, now).map((h) => h.person)
  }

  /** The same, as a hello passes them on. */
  wire(syncId: string, skip: string | undefined, now = Date.now()): PresenceWire[] {
    return this.fresh(syncId, skip, now).map((h) => ({ ...h.person, age: now - h.at }))
  }

  clear(): void {
    this.heard.clear()
  }

  /** A universe's entries heard in the last half minute, but `skip`'s; older ones are forgotten. */
  private fresh(syncId: string, skip: string | undefined, now: number): Heard[] {
    const book = this.heard.get(syncId)
    if (!book) return []
    for (const [login, h] of book) if (now - h.at >= PRESENCE_MS) book.delete(login)
    if (!book.size) this.heard.delete(syncId)
    return [...book.values()].filter((h) => h.person.login !== skip)
  }
}
