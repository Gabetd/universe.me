import { z } from 'zod'
import { Id } from './schema'

/**
 * Pictures and Blender scenes kept with a character or an event (PLAN.md §9,
 * M29). The file itself is an asset of the project; the record lists it.
 */
export const MEDIA_KINDS = ['image', 'blend'] as const
export const MediaKind = z.enum(MEDIA_KINDS)
export type MediaKind = z.infer<typeof MediaKind>

export const MediaItem = z.object({
  assetId: Id,
  /** The file's name, extension included. */
  name: z.string().trim().min(1).max(260),
  kind: MediaKind
})
export type MediaItem = z.infer<typeof MediaItem>

/** Records that keep media. */
export const MEDIA_OWNERS = ['character', 'event'] as const
export const MediaOwner = z.object({ kind: z.enum(MEDIA_OWNERS), id: Id })
export type MediaOwner = z.infer<typeof MediaOwner>

/** The biggest file kept, in bytes. */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024

export const BLEND_MIME = 'application/x-blender'

/** The extensions a file picker offers. */
export const MEDIA_EXTENSIONS = { image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'], blend: ['blend'] } as const satisfies Record<MediaKind, readonly string[]>

const startsWith = (bytes: Uint8Array, at: number, signature: string | number[]) => {
  const want = typeof signature === 'string' ? [...signature].map((c) => c.charCodeAt(0)) : signature
  return want.every((b, i) => bytes[at + i] === b)
}

/** How a .blend file is compressed: gzip (Blender before 3.0), zstd (from 3.0), or not at all. */
export function blendCompression(bytes: Uint8Array): 'gzip' | 'zstd' | null {
  if (startsWith(bytes, 0, [0x1f, 0x8b])) return 'gzip'
  if (startsWith(bytes, 0, [0x28, 0xb5, 0x2f, 0xfd])) return 'zstd'
  return null
}

/**
 * What a file is, from its first bytes (not its name, which can say
 * anything): a picture's MIME type, a Blender file's, or undefined. A
 * compressed Blender file only shows it's compressed, so its name has to end
 * in .blend too.
 */
export function sniffMedia(bytes: Uint8Array, name: string): string | undefined {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, 0, 'GIF8')) return 'image/gif'
  if (startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WEBP')) return 'image/webp'
  if (startsWith(bytes, 0, 'BM')) return 'image/bmp'
  if (startsWith(bytes, 4, 'ftypavi')) return 'image/avif'
  if (startsWith(bytes, 0, 'BLENDER')) return BLEND_MIME
  if (blendCompression(bytes) && /\.blend\d*$/i.test(name)) return BLEND_MIME
  return undefined
}

export const mediaKindOf = (mime: string): MediaKind => (mime === BLEND_MIME ? 'blend' : 'image')

const SEEKABLE_MAGIC = 0x8f92eab1

/**
 * Where each zstd frame of a compressed .blend file lies. Blender writes the
 * file in frames listed in a seek table at the end (zstd's seekable format),
 * and a decompressor that reads one frame stops after the first. One frame
 * covering everything if there's no table.
 */
export function zstdFrames(bytes: Uint8Array): { start: number; length: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.length
  const whole = [{ start: 0, length: end }]
  if (end < 17 || view.getUint32(end - 4, true) !== SEEKABLE_MAGIC) return whole
  const frames = view.getUint32(end - 9, true)
  const entry = view.getUint8(end - 5) & 0x80 ? 12 : 8
  const table = end - 9 - frames * entry
  if (table < 8) return whole
  const out: { start: number; length: number }[] = []
  let start = 0
  for (let i = 0; i < frames; i++) {
    const length = view.getUint32(table + i * entry, true)
    if (start + length > table) return whole
    out.push({ start, length })
    start += length
  }
  return out
}
