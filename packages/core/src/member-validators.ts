import { CommandError, liveNode, type Check } from './command-kit'
import { memberWithLogin, type Member } from './members'
import type { Store } from './store'

/** The checks on a universe's members (members.ts), run on every create, update and restore (record-kit.ts). */

/** Checks a member: they belong to the universe itself, and once. */
function checkMember(store: Store, m: Member, { verified }: Check<'member'>): void {
  if (!verified.has(m.ownerId) && liveNode(store, m.ownerId).kind !== 'universe') throw new CommandError('Members belong to the universe itself')
  const twin = memberWithLogin(store.records('member').byOwner(m.ownerId), m.login)
  if (twin && twin.id !== m.id) throw new CommandError(`${m.login} is already a member`)
}

export const memberValidators = { member: checkMember }
