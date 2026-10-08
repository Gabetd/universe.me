import { describe, expect, it } from 'vitest'
import { funnelPort, readStatus } from './tailscale'

const HOST = 'studio.tail1234.ts.net'

describe('reading Tailscale', () => {
  it('finds this computer’s name, and whether Tailscale is running', () => {
    expect(readStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` } }))).toEqual({ running: true, backend: 'Running', host: HOST })
    expect(readStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }))).toEqual({ running: false, backend: 'NeedsLogin' })
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
