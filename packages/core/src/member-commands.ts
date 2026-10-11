import { z } from 'zod'
import { batchOf } from './command-kit'
import type { HandlerMap } from './commands'
import { Login, Member, memberWithLogin, personOf } from './members'
import { NewId, create, recordCrud } from './record-kit'
import { Id, Name, type CommandSource } from './schema'

/** Inviting people to a universe and removing them (members.ts), through the bus like every record. */

const members = recordCrud('member', Member.pick({ name: true }))

/** Someone by their login, with what to call them if it's known. */
const Person = z.object({ login: Login, name: Name.optional() })

export const MEMBER_COMMANDS = [
  /**
   * Someone the universe (its root node, `ownerId`) is shared with. The
   * person inviting (`invitedBy`) is made a member too if they aren't one
   * yet, so the invitee's devices answer theirs; undone together.
   */
  z.object({ type: z.literal('member.create'), payload: Person.extend({ ...NewId, ownerId: Id, invitedBy: Person.optional() }) }),
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

export const memberHandlers: HandlerMap<MemberCommand> = {
  'member.create': (store, { id, ownerId, login, name, invitedBy }, ctx) => {
    const made = create(store, 'member', ctx, ownerId, id, { ...personOf(login, name), invitedBy: invitedBy?.login ?? null })
    if (!invitedBy || memberWithLogin(store.records('member').byOwner(ownerId), invitedBy.login)) return made
    const inviter = create(store, 'member', ctx, ownerId, undefined, { ...personOf(invitedBy.login, invitedBy.name), invitedBy: null }, [ownerId])
    return { ...made, inverse: batchOf([inviter.inverse, made.inverse]) }
  },
  'member.update': members.update,
  'member.delete': members.delete
}
