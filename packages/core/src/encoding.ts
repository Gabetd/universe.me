const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** The character code of each 6-bit value, and of the padding. */
const CODES = Uint8Array.from(ALPHABET, (c) => c.charCodeAt(0))
const PAD = '='.charCodeAt(0)
const ascii = new TextDecoder()

/** Base64 for binary command payloads, written straight into a byte buffer (no string building). */
export function bytesToBase64(bytes: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4)
  const whole = bytes.length - (bytes.length % 3)
  let o = 0
  for (let i = 0; i < whole; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out[o++] = CODES[n >> 18]!
    out[o++] = CODES[(n >> 12) & 63]!
    out[o++] = CODES[(n >> 6) & 63]!
    out[o++] = CODES[n & 63]!
  }
  if (whole < bytes.length) {
    const two = whole + 1 < bytes.length
    const n = (bytes[whole]! << 16) | (two ? bytes[whole + 1]! << 8 : 0)
    out[o++] = CODES[n >> 18]!
    out[o++] = CODES[(n >> 12) & 63]!
    out[o++] = two ? CODES[(n >> 6) & 63]! : PAD
    out[o] = PAD
  }
  return ascii.decode(out)
}

/** atob (in Node and browsers) is as fast as a lookup table here, and rejects malformed input. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Views typed-array data as bytes without copying. */
export function asBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}
