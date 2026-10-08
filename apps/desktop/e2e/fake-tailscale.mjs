// A stand-in for the `tailscale` command in the e2e tests (UNIVERSE_TAILSCALE): signed in as
// studio.tail1234.ts.net, with Funnel's state kept in FAKE_TAILSCALE_STATE.
import { readFileSync, writeFileSync } from 'node:fs'

const HOST = 'studio.tail1234.ts.net'
const file = process.env.FAKE_TAILSCALE_STATE
const read = () => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}
const args = process.argv.slice(2)
const has = (...words) => words.every((w) => args.includes(w))

if (has('status', '--json') && !has('funnel')) {
  process.stdout.write(JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` } }))
} else if (has('funnel', 'status', '--json')) {
  const { port } = read()
  const at = `${HOST}:443`
  process.stdout.write(port ? JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [at]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } }, AllowFunnel: { [at]: true } }) : '{}')
} else if (has('funnel', 'off')) {
  writeFileSync(file, '{}')
} else if (has('funnel', '--bg')) {
  writeFileSync(file, JSON.stringify({ port: Number(args.at(-1)) }))
  process.stdout.write(`Available on the internet:\n\nhttps://${HOST}/\n`)
} else {
  process.stderr.write(`fake tailscale: unknown command ${args.join(' ')}\n`)
  process.exit(1)
}
