import type { MediaItem, MediaOwner } from '@universe/core'
import { useRef, useState, type DragEvent } from 'react'
import { MEDIA_ACCEPT, attachFiles, useAssetUrl, useBlendThumbnail } from '../media/assets'
import { useUi } from '../store'
import { hinted } from './Hint'
import { MediaViewer } from './MediaViewer'
import { Thumbnail } from './Thumbnail'

/**
 * A character's or an event's pictures and Blender scenes (PLAN.md §9, M29):
 * a tile for each, opened large with a click; added with the button or by
 * dropping files on it.
 */
export function MediaGallery({ owner, media, label }: { owner: MediaOwner; media: MediaItem[]; label: string }) {
  const [open, setOpen] = useState<number | null>(null)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const execute = useUi((s) => s.execute)
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  const add = (files: FileList | null) => void (files?.length && attachFiles(owner, [...files]))

  return (
    <div
      className={`field media-gallery${over ? ' dropping' : ''}`}
      role="group"
      aria-label={label}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setOver(true)
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        setOver(false)
        add(e.dataTransfer.files)
      }}
      {...hinted('Pictures and Blender scenes (.blend) of them. Click one to see it large, or drop files here to add them.')}
    >
      <span>{label}</span>
      {media.length > 0 && (
        <ul className="media-tiles">
          {media.map((item, i) => (
            <li key={item.assetId}>
              <button className="media-tile" aria-label={`Open ${item.name}`} title={item.name} onClick={() => setOpen(i)}>
                {item.kind === 'image' ? <PictureTile item={item} /> : <BlendTile item={item} />}
              </button>
              <button
                className="icon media-remove"
                aria-label={`Remove ${item.name}`}
                title={`Remove ${item.name}`}
                onClick={() => void execute({ type: 'media.detach', payload: { to: owner, assetId: item.assetId } })}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="add-buttons">
        <button onClick={() => input.current?.click()}>🖼 Add pictures or .blend files…</button>
        <input ref={input} type="file" multiple hidden accept={MEDIA_ACCEPT} aria-label={`Add to ${label}`} onChange={(e) => (add(e.target.files), (e.target.value = ''))} />
      </div>
      {media.length === 0 && <p className="muted small">None yet. Add some, or drop them here.</p>}
      {open !== null && media[open] && <MediaViewer media={media} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </div>
  )
}

function PictureTile({ item }: { item: MediaItem }) {
  const url = useAssetUrl(item.assetId)
  return url ? <img src={url} alt={item.name} draggable={false} /> : <span className="media-placeholder">🖼</span>
}

function BlendTile({ item }: { item: MediaItem }) {
  const thumbnail = useBlendThumbnail(item.assetId)
  return (
    <>
      {thumbnail.state === 'ready' && thumbnail.value ? <Thumbnail picture={thumbnail.value} label={item.name} /> : <span className="media-placeholder">🧊</span>}
      <span className="media-badge">.blend</span>
    </>
  )
}
