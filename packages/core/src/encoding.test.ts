import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64 } from './index'

/** The obvious implementation, to check the fast one against. */
const reference = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))

let seed = 7
const randomBytes = (n: number) => Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24)

describe('base64', () => {
  it('matches btoa and round-trips random bytes of awkward lengths', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 31, 32, 33, 64, 65, 255, 256, 257, 1000, 4097, 65_537, 128 * 1024 + 2]) {
      const bytes = randomBytes(n)
      const text = bytesToBase64(bytes)
      expect(text).toBe(reference(bytes))
      expect(base64ToBytes(text)).toEqual(bytes)
    }
  })

  it('encodes every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(bytesToBase64(bytes)).toBe(reference(bytes))
    expect(bytesToBase64(bytes.subarray(1, 255))).toBe(reference(bytes.subarray(1, 255)))
  })
})
