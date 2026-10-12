import { beforeEach, describe, expect, it } from 'vitest'
import { CommandBus, MemoryStore, createRootUniverse, memberWithLogin, refKey, rowsFrom, type Command, type CommandSource } from './index'
import { refusal } from './member-commands'

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

  it('have roles: the first to share it owns it, the others edit or only look', () => {
    run('member.create', { ownerId: rootId, login: 'bob@example.com', invitedBy: { login: 'alice@example.com', name: 'Alice' } })
    run('member.create', { ownerId: rootId, login: 'carol@example.com', role: 'viewer', invitedBy: { login: 'alice@example.com' } })
    const members = () => store.records('member').all()
    expect(Object.fromEntries(members().map((m) => [m.login, m.role]))).toEqual({ 'alice@example.com': 'owner', 'bob@example.com': 'editor', 'carol@example.com': 'viewer' })
    const bob = memberWithLogin(members(), 'bob@example.com')!
    expect(() => run('member.update', { id: bob.id, patch: { role: 'owner' } })).toThrow(/one owner/)
    expect(() => run('member.create', { ownerId: rootId, login: 'dan@example.com', role: 'owner' })).toThrow()

    const invite = { type: 'member.create', payload: { ownerId: rootId, login: 'eve@example.com' } }
    const edit = { type: 'node.update', payload: { id: rootId, patch: { name: 'V' } } }
    expect(refusal(members(), 'alice@example.com', invite)).toBeUndefined()
    expect(refusal(members(), 'bob@example.com', edit)).toBeUndefined()
    expect(refusal(members(), 'bob@example.com', invite)).toMatch(/Only Alice/)
    expect(refusal(members(), 'carol@example.com', edit)).toMatch(/to look at/)

    const rows = [{ key: refKey({ t: 'record', kind: 'member', id: bob.id }) }, { key: refKey({ t: 'node', id: rootId }) }]
    expect(rowsFrom(members(), 'alice@example.com', rows)).toEqual(rows)
    expect(rowsFrom(members(), 'bob@example.com', rows)).toEqual([rows[1]])
    expect(rowsFrom(members(), 'carol@example.com', rows)).toEqual([])
  })

  it('make a member from before roles who invites someone the owner, undone together', () => {
    run('member.create', { ownerId: rootId, login: 'alice@example.com' })
    const alice = store.records('member').all()[0]!
    store.transaction(() => store.records('member').update({ ...alice, role: 'editor' }))
    run('member.create', { ownerId: rootId, login: 'bob@example.com', invitedBy: { login: 'alice@example.com' } })
    expect(memberWithLogin(store.records('member').all(), 'alice@example.com')!.role).toBe('owner')
    bus.undo()
    expect(store.records('member').all().map((m) => [m.login, m.role])).toEqual([['alice@example.com', 'editor']])
  })
})
