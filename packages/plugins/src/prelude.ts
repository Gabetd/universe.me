/**
 * What a plugin's code sees of the app (PLAN.md §9, M16): the `universe`
 * object, made in the sandbox before the plugin's code runs from the few
 * functions the host gives it (`__host`, gone once this has run). Everything
 * crosses as JSON text; bytes as base64.
 */
export const PRELUDE = String.raw`
(() => {
  const host = globalThis.__host
  delete globalThis.__host
  // Base64 is done by the host (natively: it's much faster than here); bytes cross as ArrayBuffers.
  const toBase64 = (bytes) => host.toBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const fromBase64 = (text) => new Uint8Array(host.fromBase64(text))
  const bytesOf = (b) => (b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : Array.isArray(b) ? Uint8Array.from(b) : null)
  const show = (v) => (typeof v === 'string' ? v : (() => { try { return JSON.stringify(v) } catch { return String(v) } })())

  const universe = Object.freeze({
    /** One of the app's operations (as Claude has them over MCP): list_worlds, get_world, create_event, create_region… */
    call: (operation, input) => host.call(operation, JSON.stringify(input ?? {})).then((json) => JSON.parse(json)),
    /** A text file the user picks, as { name, text }, or null if they don't pick one. */
    pickFile: (options) => host.pickFile(JSON.stringify(options ?? {})).then((json) => JSON.parse(json)),
    /** A PNG image (bytes) of RGBA pixels, row by row from the top left. */
    png: (width, height, rgba) => {
      const bytes = bytesOf(rgba)
      if (!bytes || bytes.length !== width * height * 4) throw new Error('png(width, height, rgba) takes width × height × 4 bytes')
      return host.png(width, height, toBase64(bytes)).then((json) => fromBase64(JSON.parse(json)))
    },
    /** Bytes from base64 (as get_world_map gives its pixels), and back. */
    fromBase64: (text) => fromBase64(String(text)),
    toBase64: (bytes) => toBase64(bytesOf(bytes) ?? new Uint8Array()),
    /** A line in the plugin's log, in the app's plugin manager. */
    log: (...parts) => host.log(parts.map(show).join(' ')),
    /** Random numbers (0 to 1) from a seed: the same seed, the same numbers. */
    random: (seed) => {
      let a = (Number(seed) || 0) >>> 0
      return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }
  })
  globalThis.universe = universe
  globalThis.console = Object.freeze({ log: universe.log, info: universe.log, warn: universe.log, error: universe.log })

  /** Runs one contribution, and gives back what it made as JSON. */
  globalThis.__invoke = async (exports, kind, id, input) => {
    const fn = exports && exports[kind] && exports[kind][id]
    if (typeof fn !== 'function') throw new Error('Its code exports no ' + kind + '.' + id + ' function (export const ' + kind + ' = { ' + id + '(input) { … } })')
    const out = await fn(JSON.parse(input), universe)
    if (kind === 'exporters') {
      const files = Array.isArray(out) ? out : out ? [out] : []
      return JSON.stringify(files.map((f) => {
        const bytes = f && f.bytes !== undefined ? bytesOf(f.bytes) : null
        return bytes ? { name: f.name, base64: toBase64(bytes) } : { name: f && f.name, text: f && typeof f.text === 'string' ? f.text : undefined }
      }))
    }
    return JSON.stringify(out ?? null)
  }
})()
`
