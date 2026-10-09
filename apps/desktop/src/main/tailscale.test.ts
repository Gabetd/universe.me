import { describe, expect, it } from 'vitest'
import { funnelPort, readStatus } from './tailscale'

const HOST = 'studio.tail1234.ts.net'

describe('reading Tailscale', () => {
  it('finds this computer’s name, and whether Tailscale is running', () => {
    expect(readStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` } }))).toEqual({ running: true, backend: 'Running', host: HOST, peers: [] })
    expect(readStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }))).toEqual({ running: false, backend: 'NeedsLogin', peers: [] })
  })

  it('finds who’s signed in, and their own other devices that are on', () => {
    const status = {
      BackendState: 'Running',
      Self: { DNSName: `${HOST}.`, UserID: 7 },
      User: { 7: { LoginName: 'me@example.com' } },
      Peer: {
        a: { DNSName: 'laptop.tail1234.ts.net.', HostName: 'laptop', UserID: 7, Online: true },
        b: { DNSName: 'old.tail1234.ts.net.', HostName: 'old', UserID: 7, Online: false },
        c: { DNSName: 'friend.tail1234.ts.net.', HostName: 'friend', UserID: 9, Online: true }
      }
    }
    expect(readStatus(JSON.stringify(status))).toMatchObject({ login: 'me@example.com', peers: [{ host: 'laptop.tail1234.ts.net', name: 'laptop' }] })
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
