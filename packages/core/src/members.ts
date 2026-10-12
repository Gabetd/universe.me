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

/**
 * What a member may do (M20): the owner (the first to share it) changes who
 * it's shared with; an editor changes the universe; a viewer only looks.
 * Members from before roles are editors, and while a universe has no owner,
 * every editor may change who it's shared with, as before.
 */
export const MEMBER_ROLES = ['owner', 'editor', 'viewer'] as const
export const MemberRole = z.enum(MEMBER_ROLES)
export type MemberRole = z.infer<typeof MemberRole>

export const ROLE_LABELS: Record<MemberRole, string> = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' }

export const Member = z.object({
  ...RecordMeta,
  login: Login,
  /** What they're called, as Tailscale (or the person inviting them) gave it. */
  name: Name,
  /** Who invited them, if anyone did. */
  invitedBy: Login.nullable(),
  role: MemberRole.default('editor')
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

/** The universe's owner, if it has one. */
export const ownerOf = (members: readonly Member[]) => members.find((m) => m.role === 'owner')

/** Whether someone may change who the universe is shared with: its owner, or (while it has none) any editor. */
export function managesMembers(members: readonly Member[], login: string): boolean {
  const owner = ownerOf(members)
  return owner ? owner.login === normalLogin(login) : memberWithLogin(members, login)?.role !== 'viewer'
}

/** Whether someone shared the universe to look at it alone. */
export const onlyViews = (members: readonly Member[], login: string) => memberWithLogin(members, login)?.role === 'viewer'

const MEMBER_ROW = /^\["record","member",/

/**
 * The rows from someone's devices a copy takes (PLAN.md §6.7, M20): none
 * from a person who can only look, and changes to who it's shared with only
 * from someone who manages that (the owner). The user's own devices are
 * trusted as the user is.
 */
export function rowsFrom<R extends { key: string }>(members: readonly Member[], login: string, rows: readonly R[]): R[] {
  if (onlyViews(members, login)) return []
  return managesMembers(members, login) ? [...rows] : rows.filter((r) => !MEMBER_ROW.test(r.key))
}