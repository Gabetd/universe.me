import { z } from 'zod'
import { Name, RecordMeta } from './schema'

/**
 * The people a universe is shared with (PLAN.md §6.7, M18), by their tailnet
 * login: not the members of a faction (`membership`, factions.ts). They
 * belong to the universe itself (its root node) and sync with it like any
 * record, so every copy knows who may sync it: a device answers another
 * person's devices only while that person is a member of the universe it
 * has open.
 */

/**
 * A tailnet login name, as Tailscale gives it: an email address, or a name
 * at the service it signs in with ("alice@github"). Kept in lower case, as
 * logins don't differ by case.
 */
export const Login = z.string().trim().toLowerCase().min(3).max(320).regex(/^[^\s@]+@[^\s@]+$/, 'A tailnet login looks like an email address')
export type Login = z.infer<typeof Login>

export const Member = z.object({
  ...RecordMeta,
  login: Login,
  /** What they're called, as Tailscale (or the person inviting them) gave it. */
  name: Name,
  /** Who invited them, if anyone did. */
  invitedBy: Login.nullable()
})
export type Member = z.infer<typeof Member>

/** A login as members keep it, for comparing. */
export const normalLogin = (login: string) => login.trim().toLowerCase()

/** The member with this login, if there is one. */
export const memberWithLogin = (members: readonly Member[], login: string) => {
  const wanted = normalLogin(login)
  return members.find((m) => m.login === wanted)
}

/** What to call someone known only by their login: the part before the @. */
export const loginName = (login: string) => normalLogin(login).split('@')[0] || login

/** Someone by their login (as members keep it), called `name` if that's known, or else after their login. */
export const personOf = (login: string, name?: string) => ({ login: normalLogin(login), name: name ?? loginName(login) })
