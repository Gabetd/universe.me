import { beforeEach, describe, expect, it } from 'vitest'
import { CommandBus, MemoryStore, createRootUniverse, memberWithLogin, type Command, type CommandSource } from './index'

let store: MemoryStore
let bus: CommandBus
let rootId: string

beforeEach(() => {
  store = new MemoryStore()
  let n = 0
  bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 1 } })
  rootId = createRootUniverse(store, 'U').id
})

const run = (type: string, payload: object, source?: CommandSource) => bus.execute({ type, payload } as Command, source)
const logins = () => store.records('member').all().map((m) => m.login).sort()

describe('a universe’s members', () => {
  it('are invited by login, with the person inviting added too, and removed; each undoes in one step', () => {
    run('member.create', { ownerId: rootId, login: ' Bob@Example.com ', invitedBy: { login: 'alice@example.com', name: 'Alice' } })
    expect(logins()).toEqual(['alice@example.com', 'bob@example.com'])
    const members = store.records('member').all()
    expect(memberWithLogin(members, 'BOB@example.com')).toMatchObject({ name: 'bob', invitedBy: 'alice@example.com' })
    expect(memberWithLogin(members, 'alice@example.com')).toMatchObject({ name: 'Alice', invitedBy: null })
    // The person inviting is listed once, however many they invite.
    run('member.create', { ownerId: rootId, login: 'carol@github', name: 'Carol', invitedBy: { login: 'alice@example.com' } })
    expect(logins()).toEqual(['alice@example.com', 'bob@example.com', 'carol@github'])
    bus.undo()
    bus.undo()
    expect(logins()).toEqual([])
    bus.redo()
    expect(logins()).toEqual(['alice@example.com', 'bob@example.com'])
    run('member.delete', { id: memberWithLogin(store.records('member').all(), 'bob@example.com')!.id })
    expect(logins()).toEqual(['alice@example.com'])
    run('member.update', { id: memberWithLogin(store.records('member').all(), 'alice@example.com')!.id, patch: { name: 'Alice B.' } })
    expect(store.records('member').all()[0]!.name).toBe('Alice B.')
  })

  it('belong to the universe itself, once each, by a login Tailscale could give', () => {
    run('member.create', { ownerId: rootId, login: 'bob@example.com' })
    expect(() => run('member.create', { ownerId: rootId, login: 'BOB@example.com' })).toThrow(/already a member/)
    expect(() => run('member.create', { ownerId: rootId, login: 'not a login' })).toThrow(/tailnet login/)
    const cluster = run('node.create', { parentId: rootId, kind: 'galaxy_cluster' }).targetId!
    expect(() => run('member.create', { ownerId: cluster, login: 'carol@example.com' })).toThrow(/universe itself/)
  })

  it('are the user’s to change: a plugin or an AI client can’t, not even in a batch', () => {
    const invite = { type: 'member.create', payload: { ownerId: rootId, login: 'mallory@example.com' } }
    expect(() => run(invite.type, invite.payload, 'plugin')).toThrow(/in Universe itself/)
    expect(() => run('batch', { commands: [{ type: 'batch', payload: { commands: [invite] } }] }, 'ai')).toThrow(/in Universe itself/)
    run('member.create', { ownerId: rootId, login: 'bob@example.com' })
    const bob = store.records('member').all()[0]!
    expect(() => run('record.remove', { refs: [{ kind: 'member', id: bob.id }] }, 'plugin')).toThrow(/in Universe itself/)
    expect(() => run('member.update', { id: bob.id, patch: { name: 'Bobby' } }, 'ai')).toThrow(/in Universe itself/)
    expect(logins()).toEqual(['bob@example.com'])
  })
})
