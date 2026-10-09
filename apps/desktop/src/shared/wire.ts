import { base64ToBytes, bytesToBase64 } from '@universe/core'

/**
 * JSON as the phone app's bridge sends it (PLAN.md §6.6): what Electron's
 * IPC carries as is but JSON can't — byte arrays (terrain layers, assets) and
 * gaps in arrays (a face with no edits) — written so they read back the same.
 */

const BYTES = '$bytes'
const GAP = '$gap'

export function toWire(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, _key, v: unknown) {
    if (v instanceof Uint8Array) return { [BYTES]: bytesToBase64(v) }
    // In an array, undefined would come back as null.
    if (v === undefined && Array.isArray(this)) return { [GAP]: 1 }
    return v
  })
}

export function fromWire<T = unknown>(text: string): T {
  return restore(JSON.parse(text)) as T
}

const only = (v: object, key: string) => {
  const keys = Object.keys(v)
  return keys.length === 1 && keys[0] === key
}

/** Byte arrays and gaps back as they were (a reviver can't put undefined in an array: it leaves a hole). */
function restore(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' && only(x, GAP) ? undefined : restore(x)))
  if (!v || typeof v !== 'object') return v
  const bytes = (v as Record<string, unknown>)[BYTES]
  if (only(v, BYTES) && typeof bytes === 'string') return base64ToBytes(bytes)
  for (const key of Object.keys(v)) (v as Record<string, unknown>)[key] = restore((v as Record<string, unknown>)[key])
  return v
}
