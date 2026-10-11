import { describe, expect, it } from 'vitest'
import { funnelPort, readStatus } from './tailscale'

const HOST = 'studio.tail1234.ts.net'

describe('reading Tailscale', () => {
  it('finds this computer’s name, and whether Tailscale is running', () => {
    expect(readStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` } }))).toEqual({ running: true, backend: 'Running', host: HOST, peers: [], others: [] })
    expect(readStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }))).toEqual({ running: false, backend: 'NeedsLogin', peers: [], others: [] })
  })

  it('finds who’s signed in (their login as members keep it), and their own other devices that are on', () => {
    const status = {
      BackendState: 'Running',
      Self: { DNSName: `${HOST}.`, UserID: 7 },
      User: { 7: { LoginName: 'Me@Example.com', DisplayName: 'Me' } },
      Peer: {
        a: { DNSName: 'laptop.tail1234.ts.net.', HostName: 'laptop', UserID: 7, Online: true },
        b: { DNSName: 'old.tail1234.ts.net.', HostName: 'old', UserID: 7, Online: false },
        c: { DNSName: 'friend.tail1234.ts.net.', HostName: 'friend', UserID: 9, Online: true }
      }
    }
    expect(readStatus(JSON.stringify(status))).toMatchObject({ login: 'me@example.com', name: 'Me', peers: [{ host: 'laptop.tail1234.ts.net', name: 'laptop', login: 'me@example.com' }] })
  })

  it('finds other people’s devices this computer can reach, each with whose it is', () => {
    const status = {
      BackendState: 'Running',
      Self: { DNSName: `${HOST}.`, UserID: 7 },
      User: { 7: { LoginName: 'me@example.com' }, 9: { LoginName: 'bob@example.com', DisplayName: 'Bob' }, 11: { LoginName: 'carol@github', DisplayName: 'Carol' }, 12: { LoginName: 'tagged-devices' } },
      Peer: {
        a: { DNSName: 'laptop.tail1234.ts.net.', HostName: 'laptop', UserID: 7, Online: true },
        // Bob's machine, shared into this tailnet.
        b: { DNSName: 'bobs-studio.tail5678.ts.net.', HostName: 'bobs-studio', UserID: 9, Online: true },
        c: { DNSName: 'bobs-old.tail5678.ts.net.', HostName: 'bobs-old', UserID: 9, Online: false },
        // Carol's laptop is listed because this computer is shared with her: it can come here, not this one there.
        d: { DNSName: 'carols-laptop.tail9999.ts.net.', HostName: 'carols-laptop', UserID: 11, Online: true, ShareeNode: true },
        // A server of the tailnet's, no one's.
        e: { DNSName: 'build.tail1234.ts.net.', HostName: 'build', UserID: 12, Online: true, Tags: ['tag:ci'] }
      }
    }
    const read = readStatus(JSON.stringify(status))
    expect(read.peers).toEqual([{ host: 'laptop.tail1234.ts.net', name: 'laptop', login: 'me@example.com' }])
    expect(read.others).toEqual([{ host: 'bobs-studio.tail5678.ts.net', name: 'bobs-studio', login: 'bob@example.com', ownerName: 'Bob' }])
  })

  it('finds the port Funnel forwards the public address to, only while Funnel is on for it', () => {
    const web = { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:47615' } } } }
    expect(funnelPort(JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: web, AllowFunnel: { [`${HOST}:443`]: true } }), HOST)).toBe(47615)
    // Served on the tailnet only, not funneled.
    expect(funnelPort(JSON.stringify({ Web: web }), HOST)).toBeNull()
    // Something else behind it: not the app.
    expect(funnelPort(JSON.stringify({ Web: { [`${HOST}:443`]: { Handlers: { '/': { Path: '/srv' } } } }, AllowFunnel: { [`${HOST}:443`]: true } }), HOST)).toBeNull()
    expect(funnelPort('', HOST)).toBeNull()
  })
})
