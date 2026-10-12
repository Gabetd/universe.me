import { z } from 'zod'
import { batchOf } from './command-kit'
import type { HandlerMap } from './commands'
import { Login, Member, MemberRole, managesMembers, memberWithLogin, onlyViews, ownerOf, personOf, type Member as MemberRecord } from './members'
import { NewId, create, recordCrud } from './record-kit'
import { Id, Name, type CommandSource } from './schema'

/** Inviting people to a universe and removing them (members.ts), through the bus like every record. */

const members = recordCrud('member', Member.pick({ name: true, role: true }))

/** Someone by their login, with what to call them if it's known. */
const Person = z.object({ login: Login, name: Name.optional() })

export const MEMBER_COMMANDS = [
  /**
   * Someone the universe (its root node, `ownerId`) is shared with, to edit
   * it or only look (`role`). The person inviting (`invitedBy`) is made a
   * member too if they aren't one yet, so the invitee's devices answer
   * theirs, and its owner if it has none yet; undone together.
   */
  z.object({ type: z.literal('member.create'), payload: Person.extend({ ...NewId, ownerId: Id, invitedBy: Person.optional(), role: MemberRole.exclude(['owner']).optional() }) }),
  ...members.commands
] as const

type MemberCommand = z.infer<(typeof MEMBER_COMMANDS)[number]>

/**
 * The commands only the user sends, in Universe itself: who the universe is
 * shared with gives people its files, so an AI client or a plugin can't
 * change it, not even in a batch or for review (`checkSource`).
 */
export const USER_ONLY_COMMANDS: ReadonlySet<string> = new Set(MEMBER_COMMANDS.map((c) => c.shape.type.value))

/** The sources that can't send them. */
export const NOT_THE_USER: ReadonlySet<CommandSource> = new Set(['ai', 'plugin'])

/** Whether a command changes who the universe is shared with: a member command, or a member taken out or put back as a record. */
export function changesMembers(command: { type: string; payload: unknown }): boolean {
  if (USER_ONLY_COMMANDS.has(command.type)) return true
  const refs = command.type === 'record.remove' || command.type === 'record.restore' ? (command.payload as { refs: { kind: string }[] }).refs : []
  return refs.some((ref) => ref.kind === 'member')
}

/** Why someone (by their tailnet login) can't send a command to a universe with these members, if they can't: one who can only look changes nothing, and only its owner changes who it's shared with. */
export function refusal(members: readonly MemberRecord[], login: string, command: { type: string; payload: unknown }): string | undefined {
  const owner = ownerOf(members)
  if (onlyViews(members, login)) return `${owner?.name ?? 'Its owner'} shared this universe with you to look at, not to change.`
  if (changesMembers(command) && !managesMembers(members, login)) return `Only ${owner?.name ?? 'its owner'}, who shares this universe, can change who it’s shared with.`
  return undefined
}

export const memberHandlers: HandlerMap<MemberCommand> = {
  'member.create': (store, { id, ownerId, login, name, invitedBy, role = 'editor' }, ctx, run) => {
    const all = store.records('member').byOwner(ownerId)
    const made = create(store, 'member', ctx, ownerId, id, { ...personOf(login, name), invitedBy: invitedBy?.login ?? null, role })
    if (!invitedBy) return made
    const inviter = memberWithLogin(all, invitedBy.login)
    const owns = ownerOf(all) ? undefined : 'owner'
    if (inviter && !owns) return made
    // The person inviting is listed (as its owner, if it has none), or made its owner.
    const listed = inviter
      ? run({ type: 'member.update', payload: { id: inviter.id, patch: { role: 'owner' } } })
      : create(store, 'member', ctx, ownerId, undefined, { ...personOf(invitedBy.login, invitedBy.name), invitedBy: null, role: owns ?? 'editor' }, [ownerId])
    return { ...made, inverse: batchOf([listed.inverse, made.inverse]) }
  },
  'member.update': members.update,
  'member.delete': members.delete
}
