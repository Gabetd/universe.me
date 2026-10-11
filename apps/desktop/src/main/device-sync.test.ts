import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OAuth, memoryStore } from '@universe/api'
import { afterEach, describe, expect, it } from 'vitest'
import type { Collaboration, TailnetPeer } from '../shared/api'
import { AskError, DeviceSync, type Ask } from './device-sync'
import { PhoneAppServer } from './phone-app'
import { Session } from './session'

/**
 * People on their own computers, each Universe with its own tailnet server
 * (phone-app.ts), as Tailscale machine sharing has them: the person a
 * machine is shared with reaches it, the machine doesn't reach them.
 */

interface Computer {
  host: string
  login: string
  name: string
  dir: string
  session: Session
  sync: DeviceSync
  server: PhoneAppServer
  port: number
  /** Other people's devices this one can reach. */
  reaches: Computer[]
  told: Collaboration[]
  /** Paths this computer was asked, by whom. */
  asked: { path: string; by: string }[]
}

const computers: Computer[] = []
/** Answers in place of a computer that isn't a Universe (or isn't what it says). */
const fakes = new Map<string, (path: string, body?: object) => unknown>()

afterEach(async () => {
  for (const c of computers.splice(0)) {
    c.sync.stop()
    c.session.close()
    await c.server.close()
    rmSync(c.dir, { recursive: true, force: true })
  }
  fakes.clear()
})

const peer = (c: Computer): TailnetPeer => ({ host: c.host, name: c.host.split('.')[0]!, login: c.login, ownerName: c.name })

/** What `tailscale serve` does for one computer asking another: who asks, added on the way; nothing if it can't reach it. */
function asker(from: () => Computer): Ask {
  return async (host, path, device, body) => {
    const fake = fakes.get(host)
    if (fake) return fake(path, body)
    const to = computers.find((c) => c.host === host)
    if (!to || !from().reaches.includes(to)) throw new AskError('It didn’t answer')
    const text = body ? JSON.stringify(body) : undefined
    const headers = { host: `${host}:8443`, 'tailscale-user-login': from().login, 'x-universe-sync': '1', 'x-universe-device': device, ...(text && { 'content-type': 'application/json' }) }
    const { status, json } = await new Promise<{ status: number; json: { error?: string } }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: to.port, path, method: body ? 'POST' : 'GET', headers }, (res) => {
        let out = ''
        res.on('data', (c: Buffer) => (out += c.toString()))
        res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(out || '{}') }))
      })
      req.on('error', reject)
      req.end(text)
    })
    if (status >= 300) throw new AskError(json.error ?? `It answered ${status}`, status)
    return json
  }
}

async function computer(host: string, login: string, name: string): Promise<Computer> {
  const dir = mkdtempSync(join(tmpdir(), 'universe-collab-'))
  mkdirSync(join(dir, 'app'))
  const session = new Session(dir)
  const c = { host, login, name, dir, session, reaches: [], told: [], asked: [] } as unknown as Computer
  c.sync = new DeviceSync({
    session,
    on: () => true,
    tailnet: () => ({ host, me: { login, name }, peers: [], others: c.reaches.map(peer) }),
    merged: () => {},
    changed: () => {},
    collaboration: (collaboration) => void c.told.push(collaboration),
    ask: asker(() => c)
  })
  const { sync } = c
  c.server = new PhoneAppServer({
    oauth: new OAuth(memoryStore()),
    appOn: () => false,
    sync: {
      on: () => true,
      mayVisit: (v) => sync.mayVisit(v),
      hello: (v, body) => (c.asked.push({ path: 'hello', by: v.login }), sync.hello(v, body)),
      changes: (body, v) => (c.asked.push({ path: 'changes', by: v.login }), sync.changes(body, v)),
      push: (body, v) => (c.asked.push({ path: 'push', by: v.login }), sync.push(body, v)),
      nudged: (body, v) => sync.nudged(body, v)
    },
    files: join(dir, 'app'),
    place: () => ({ host: `${host}:8443`, login }),
    answer: () => Promise.reject(new Error('No phone app here')),
    sessionsFile: join(dir, 'sessions.json')
  })
  c.port = await c.server.listen()
  computers.push(c)
  return c
}

const rootOf = (c: Computer) => c.session.state().project!.rootId
const invite = (c: Computer, login: string) => c.session.execute({ type: 'member.create', payload: { ownerId: rootOf(c), login, invitedBy: { login: c.login, name: c.name } } })
const rename = (c: Computer, name: string) => c.session.execute({ type: 'node.update', payload: { id: rootOf(c), patch: { name } } })
const rootName = (c: Computer) => c.session.state().nodes.find((n) => n.id === rootOf(c))!.name

/** Alice's studio, shared with Bob: his laptop reaches it. */
async function aliceAndBob() {
  const alice = await computer('studio.tail1111.ts.net', 'alice@example.com', 'Alice')
  const bob = await computer('laptop.tail2222.ts.net', 'bob@example.com', 'Bob')
  bob.reaches.push(alice)
  alice.session.create(join(alice.dir, 'Aerth.universe'))
  return { alice, bob }
}

/** Bob, invited, copies Alice's universe here. */
async function bobCopies(alice: Computer, bob: Computer, at = bob) {
  invite(alice, at.login)
  await at.sync.round()
  expect(at.sync.collaboration().shared).toEqual([expect.objectContaining({ host: alice.host, owner: { login: alice.login, name: 'Alice' }, project: expect.objectContaining({ name: 'Aerth' }), same: false })])
  await at.sync.copyFrom(alice.host, join(at.dir, 'Aerth copy.universe'))
  await at.sync.round()
}

describe('several people in one universe', () => {
  it('shares a universe only once someone’s invited: they see it, copy it here, and the two keep each other up to date both ways', async () => {
    const { alice, bob } = await aliceAndBob()
    // Not a member yet: nothing is open there, as far as Bob can tell.
    await bob.sync.round()
    expect(bob.sync.collaboration().shared).toEqual([])
    await bobCopies(alice, bob)
    expect(rootName(bob)).toBe('Aerth')
    expect(bob.session.members().map((m) => m.login).sort()).toEqual(['alice@example.com', 'bob@example.com'])
    expect(bob.sync.collaboration().shared[0]).toMatchObject({ same: true, lastSync: expect.any(Number) })

    // Bob's change goes to Alice's studio with his next visit (it can't come to him), and hers comes back.
    rename(bob, 'Aerth, by Bob')
    await bob.sync.round()
    expect(rootName(alice)).toBe('Aerth, by Bob')
    rename(alice, 'Aerth, by Alice')
    await bob.sync.round()
    expect(rootName(bob)).toBe('Aerth, by Alice')
    // Each way once: with nothing new on either side, a visit is only a hello.
    alice.asked.length = 0
    await bob.sync.round()
    expect(alice.asked.map((a) => a.path)).toEqual(['hello'])
  })

  it('stops answering someone removed, and doesn’t take what they bring', async () => {
    const { alice, bob } = await aliceAndBob()
    await bobCopies(alice, bob)
    const id = alice.session.members().find((m) => m.login === 'bob@example.com')!.id
    alice.session.execute({ type: 'member.delete', payload: { id } })
    rename(bob, 'Not Alice’s')
    await bob.sync.round()
    expect(rootName(alice)).toBe('Aerth')
    expect(bob.sync.collaboration().shared).toEqual([])
    expect(alice.asked.filter((a) => a.path === 'push')).toEqual([])
  })

  it('says who’s in and where, passes it on between visitors, and never back to the person it’s about', async () => {
    const { alice, bob } = await aliceAndBob()
    const carol = await computer('desk.tail3333.ts.net', 'carol@example.com', 'Carol')
    carol.reaches.push(alice)
    await bobCopies(alice, bob)
    await bobCopies(alice, bob, carol)
    alice.sync.setWhere({ nodeId: rootOf(alice), view: 'cosmos', label: 'Aerth, the cosmos' })
    bob.sync.setWhere({ nodeId: null, view: 'timeline', label: 'Terra, the timeline' })
    carol.sync.setWhere({ nodeId: null, view: 'map', label: 'Terra, the map' })
    // Bob and Carol each say where they are to Alice's studio, and hear the others there.
    await bob.sync.round()
    await carol.sync.round()
    await bob.sync.round()
    const here = (c: Computer) => c.sync.collaboration().here.map((p) => [p.login, p.where?.label]).sort()
    expect(here(alice)).toEqual([['bob@example.com', 'Terra, the timeline'], ['carol@example.com', 'Terra, the map']])
    expect(here(bob)).toEqual([['alice@example.com', 'Aerth, the cosmos'], ['carol@example.com', 'Terra, the map']])
    expect(here(carol)).toEqual([['alice@example.com', 'Aerth, the cosmos'], ['bob@example.com', 'Terra, the timeline']])
    // The window heard of it, once for each change.
    expect(bob.told.at(-1)!.here).toHaveLength(2)
    expect(new Set(bob.told.map((t) => JSON.stringify(t))).size).toBe(bob.told.length)
  })

  it('syncs only with the user’s own devices and members’, whatever another device says it has open', async () => {
    const { alice, bob } = await aliceAndBob()
    await bobCopies(alice, bob)
    // Mallory's machine is shared with Bob too, and claims to have the same universe open, to anyone.
    const syncId = bob.session.syncInfo()!.syncId
    const asked: string[] = []
    fakes.set('mallory.tail6666.ts.net', (path, body) => (asked.push(`${path} ${JSON.stringify(body)}`), { device: 'mallorysdevice', project: { syncId, name: 'Aerth', upTo: 5 }, people: [{ login: 'mallory@example.com', name: 'M', where: null, age: 0 }] }))
    bob.reaches.push({ host: 'mallory.tail6666.ts.net', login: 'mallory@example.com', name: 'Mallory' } as unknown as Computer)
    await bob.sync.round()
    // Asked only what it has open, saying nothing of who's in here or where.
    expect(asked).toEqual(['/sync/hello {}'])
    expect(bob.sync.collaboration().here.map((p) => p.login)).not.toContain('mallory@example.com')
    expect(bob.sync.collaboration().shared.find((d) => d.host.startsWith('mallory'))).toMatchObject({ same: false, error: expect.stringMatching(/isn’t a member/) })
  })
})
