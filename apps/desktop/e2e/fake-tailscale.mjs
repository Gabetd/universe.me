// A stand-in for the `tailscale` command in the e2e tests (UNIVERSE_TAILSCALE): signed in as
// owner@example.com (or FAKE_TAILSCALE_LOGIN) on studio.tail1234.ts.net (or FAKE_TAILSCALE_HOST),
// with the owner's other devices in FAKE_TAILSCALE_PEERS (names, comma-separated), other people's
// devices shared into the tailnet in FAKE_TAILSCALE_OTHERS (name=login, comma-separated), and
// Funnel (`port`, on 443) and Serve (`app`, on 8443, the tailnet only) kept in FAKE_TAILSCALE_STATE.
import { readFileSync, writeFileSync } from 'node:fs'

const HOST = process.env.FAKE_TAILSCALE_HOST || 'studio.tail1234.ts.net'
const LOGIN = process.env.FAKE_TAILSCALE_LOGIN || 'owner@example.com'
const PEERS = (process.env.FAKE_TAILSCALE_PEERS || '').split(',').filter(Boolean)
const OTHERS = (process.env.FAKE_TAILSCALE_OTHERS || '').split(',').filter(Boolean).map((other) => other.split('='))
const file = process.env.FAKE_TAILSCALE_STATE
const read = () => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}
const write = (change) => {
  const state = { ...read(), ...change }
  for (const key of Object.keys(state)) if (state[key] === undefined) delete state[key]
  writeFileSync(file, JSON.stringify(state))
}
const args = process.argv.slice(2)
const has = (...words) => words.every((w) => args.includes(w))

/** What `tailscale serve status --json` (and `funnel status`) print: one config for both. */
function config() {
  const { port, app } = read()
  const web = {}
  if (port) web[`${HOST}:443`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } }
  if (app) web[`${HOST}:8443`] = { Handlers: { '/': { Proxy: app } } }
  if (!port && !app) return '{}'
  return JSON.stringify({ Web: web, ...(port && { AllowFunnel: { [`${HOST}:443`]: true } }) })
}

if (has('status', '--json') && !has('funnel') && !has('serve')) {
  const peer = (name, UserID) => [name, { DNSName: `${name}.`, HostName: name.split('.')[0], UserID, Online: true }]
  // Each other person is a user of their own, numbered after this one.
  const logins = [...new Set(OTHERS.map(([, login]) => login))]
  const Peer = Object.fromEntries([...PEERS.map((p) => peer(p, 7)), ...OTHERS.map(([p, login]) => peer(p, 8 + logins.indexOf(login)))])
  const User = Object.fromEntries([LOGIN, ...logins].map((login, i) => [7 + i, { LoginName: login, DisplayName: login.split('@')[0] }]))
  process.stdout.write(JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.`, UserID: 7 }, User, Peer }))
} else if (has('status', '--json')) {
  process.stdout.write(config())
} else if (has('funnel', 'off')) {
  write({ port: undefined })
} else if (has('funnel', '--bg')) {
  write({ port: Number(args.at(-1)) })
  process.stdout.write(`Available on the internet:\n\nhttps://${HOST}/\n`)
} else if (has('serve', 'off')) {
  write({ app: undefined })
} else if (has('serve', '--bg')) {
  write({ app: args.at(-1) })
  process.stdout.write(`Available within your tailnet:\n\nhttps://${HOST}:8443/\n`)
} else {
  process.stderr.write(`fake tailscale: unknown command ${args.join(' ')}\n`)
  process.exit(1)
}
