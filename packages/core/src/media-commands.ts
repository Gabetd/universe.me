import { z } from 'zod'
import { CommandError, batchOf, liveRecord } from './command-kit'
import type { Command, HandlerMap } from './commands'
import { base64ToBytes, bytesToBase64 } from './encoding'
import { MAX_MEDIA_BYTES, MediaItem, MediaOwner, mediaKindOf, sniffMedia } from './media'
import { update } from './record-kit'
import { Id } from './schema'
import { AssetFields } from './structure-commands'

export const MEDIA_COMMANDS = [
  /** Keeps a picture or a .blend file in the project and lists it on a character or an event; what it is comes from its bytes. */
  z.object({ type: z.literal('media.attach'), payload: z.object({ to: MediaOwner, assetId: Id, name: MediaItem.shape.name, data: AssetFields.shape.data }) }),
  /** Takes a file off the record it's on, and out of the project. */
  z.object({ type: z.literal('media.detach'), payload: z.object({ to: MediaOwner, assetId: Id }) })
] as const

type MediaCommand = z.infer<(typeof MEDIA_COMMANDS)[number]>

/** The record's list of media, through the kind's own update (so undo and sync see an ordinary change). */
function setMedia(store: Parameters<typeof liveRecord>[0], to: MediaOwner, media: MediaItem[], ctx: Parameters<typeof update>[2]) {
  return to.kind === 'character' ? update(store, 'character', ctx, to.id, { media }) : update(store, 'event', ctx, to.id, { media })
}

export const mediaHandlers: HandlerMap<MediaCommand> = {
  'media.attach'(store, { to, assetId, name, data }, ctx) {
    const record = liveRecord(store, to.kind, to.id)
    if (store.assets.get(assetId)) throw new CommandError(`Asset ${assetId} already exists`)
    const bytes = base64ToBytes(data)
    if (bytes.length > MAX_MEDIA_BYTES) throw new CommandError(`${name} is over ${MAX_MEDIA_BYTES / 1024 / 1024} MB`)
    const mime = sniffMedia(bytes, name)
    if (!mime) throw new CommandError(`${name} isn’t a picture (PNG, JPEG, WebP, GIF, BMP, AVIF) or a Blender file`)
    store.assets.put({ id: assetId, name, mime, data: bytes })
    const changed = setMedia(store, to, [...(record.media ?? []), { assetId, name, kind: mediaKindOf(mime) }], ctx)
    return { ...changed, inverse: batchOf([changed.inverse, { type: 'asset.remove', payload: { id: assetId } }]) }
  },

  'media.detach'(store, { to, assetId }, ctx) {
    const record = liveRecord(store, to.kind, to.id)
    const media = record.media ?? []
    if (!media.some((m) => m.assetId === assetId)) throw new CommandError(`That file isn’t on this ${to.kind}`)
    const changed = setMedia(
      store,
      to,
      media.filter((m) => m.assetId !== assetId),
      ctx
    )
    const asset = store.assets.get(assetId)
    if (!asset) return changed
    store.assets.remove(assetId)
    const putBack: Command = { type: 'asset.add', payload: { id: assetId, name: asset.name, mime: asset.mime, data: bytesToBase64(asset.data) } }
    return { ...changed, inverse: batchOf([putBack, changed.inverse]) }
  }
}
