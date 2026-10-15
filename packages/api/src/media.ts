import { MEDIA_OWNERS, type MediaItem } from '@universe/core'
import { z } from 'zod'
import { findOr404, notFound } from './host'
import { operation, type ApiContext } from './operation'
import { newId, write } from './writes'

/** Pictures and Blender scenes on characters and events (core media.ts) for AI clients: what's on one, adding a file and taking one off, as the inspector does in the app. */

const Owner = { worldId: z.string(), kind: z.enum(MEDIA_OWNERS).describe('What it’s on: a character or an event'), id: z.string().describe('The character’s or the event’s id') }

/** The character or event, on that world. */
function ownerOf(ctx: ApiContext, { worldId, kind, id }: { worldId: string; kind: (typeof MEDIA_OWNERS)[number]; id: string }): { name: string; media: MediaItem[] } {
  const { timeline } = ctx.models.world(worldId)
  if (kind === 'character') {
    const c = findOr404(timeline.characters, id, 'character')
    return { name: c.name, media: c.media ?? [] }
  }
  const e = findOr404(timeline.events, id, 'event')
  return { name: e.title, media: e.media ?? [] }
}

export const MEDIA_OPERATIONS = [
  operation({
    name: 'list_media',
    title: 'List a character’s or an event’s pictures and scenes',
    description: 'The pictures and Blender scenes (.blend) kept on a character or an event: each one’s assetId, file name and kind (image or blend).',
    input: z.object(Owner),
    route: { method: 'GET', path: '/worlds/:worldId/media' },
    run: (ctx, p) => ({ media: ownerOf(ctx, p).media })
  }),
  operation({
    name: 'attach_media',
    title: 'Add a picture or a Blender scene',
    description:
      'Keeps a file on a character or an event: a picture (PNG, JPEG, WebP, GIF, BMP or AVIF) or a Blender file (.blend), as base64. What it is comes from its bytes; a compressed .blend needs its name to end in .blend. Up to 16 MB through the API (bigger ones are added in the app). Returns its assetId.',
    input: z.object({ ...Owner, name: z.string().trim().min(1).max(260).describe('The file’s name, extension included'), data: z.string().min(1).describe('The file’s bytes, base64') }),
    route: { method: 'POST', path: '/worlds/:worldId/media' },
    write: true,
    run: (ctx, p) => {
      const owner = ownerOf(ctx, p)
      const assetId = newId()
      return write(ctx, [{ type: 'media.attach', payload: { to: { kind: p.kind, id: p.id }, assetId, name: p.name, data: p.data } }], `Added ${p.name} to ${owner.name}`, { assetId })
    }
  }),
  operation({
    name: 'remove_media',
    title: 'Take a picture or scene off',
    description: 'Takes a file (by its assetId from list_media) off a character or an event, and out of the project; undoable in the app.',
    input: z.object({ ...Owner, assetId: z.string() }),
    route: { method: 'POST', path: '/worlds/:worldId/media/remove' },
    write: true,
    destructive: true,
    run: (ctx, p) => {
      const owner = ownerOf(ctx, p)
      const item = owner.media.find((m) => m.assetId === p.assetId)
      if (!item) throw notFound('file', p.assetId)
      return write(ctx, [{ type: 'media.detach', payload: { to: { kind: p.kind, id: p.id }, assetId: p.assetId } }], `Took ${item.name} off ${owner.name}`)
    }
  })
]
