import { z } from 'zod'
import { batchOf } from './command-kit'
import type { HandlerMap } from './commands'
import { Login, Member, loginName, memberWithLogin } from './members'
import { NewId, create, recordCrud } from './record-kit'
import { Id, Name } from './schema'

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

export const memberHandlers: HandlerMap<MemberCommand> = {
  'member.create': (store, { id, ownerId, login, name, invitedBy }, ctx) => {
    const made = create(store, 'member', ctx, ownerId, id, { login, name: name ?? loginName(login), invitedBy: invitedBy?.login ?? null })
    if (!invitedBy || memberWithLogin(store.records('member').byOwner(ownerId), invitedBy.login)) return made
    const inviter = create(store, 'member', ctx, ownerId, undefined, { login: invitedBy.login, name: invitedBy.name ?? loginName(invitedBy.login), invitedBy: null }, [ownerId])
    return { ...made, inverse: batchOf([inviter.inverse, made.inverse]) }
  },
  'member.update': members.update,
  'member.delete': members.delete
}
