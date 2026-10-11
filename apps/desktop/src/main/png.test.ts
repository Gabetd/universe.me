import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { encodePng } from './png'

describe('encodePng', () => {
  it('makes a PNG of the pixels given', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 0])
    const png = encodePng(2, 2, rgba)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.readUInt32BE(16)).toBe(2)
    // IHDR (8 + 13 + 4) after the signature, then IDAT: its data inflates back to the rows, each with a 0 filter byte first.
    const idat = 8 + 25
    const data = png.subarray(idat + 8, idat + 8 + png.readUInt32BE(idat))
    expect([...inflateSync(data)]).toEqual([0, ...rgba.subarray(0, 8), 0, ...rgba.subarray(8)])
    // The CRC of IEND is always the same.
    expect(png.subarray(-4).toString('hex')).toBe('ae426082')
  })

  it('turns down pixels that don’t fit the size', () => {
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow(/width × height × 4/)
    expect(() => encodePng(0, 2, new Uint8Array())).toThrow(/1 to 4096/)
  })
})
