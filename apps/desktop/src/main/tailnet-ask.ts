import { net } from 'electron'
import { AskError, type Ask } from './device-sync'
import { tailnetBase } from './tailnet'

const TIMEOUT_MS = 10_000

/**
 * Asks a device's Universe a sync question, through Electron's network stack
 * (where keepOffline lets only this through), with the headers no web page
 * can send.
 */
export const askDevice: Ask = async (host, path, device, body) => {
  const res = await net.fetch(`${tailnetBase(host)}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Universe-Sync': '1', 'X-Universe-Device': device, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const json = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new AskError(json.error ?? `It answered ${res.status}`, res.status)
  return json
}
