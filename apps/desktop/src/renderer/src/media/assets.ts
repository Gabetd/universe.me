import { MAX_MEDIA_BYTES, MEDIA_EXTENSIONS, type Command, type MediaOwner } from '@universe/core'
import { useEffect, useState } from 'react'
import { useUi } from '../store'
import { workerCalls } from '../workerCalls'
import type { BlendScene, BlendThumbnail } from './blend'
import BlendWorker from './blend.worker?worker'
import type { BlendReply, BlendRequest } from './blend.worker'

/**
 * The project's pictures and Blender scenes as the window shows them. Assets
 * never change once kept (a new file is a new asset), so what's made from one
 * is kept by its id: a picture's object URL while anything shows it, a .blend
 * file's thumbnail for good, and the last few scenes read.
 */

async function valueOf<T>(call: Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(result.error)
  return result.value
}

const pictures = new Map<string, { url: Promise<string>; users: number }>()

/** An object URL for a picture kept in the project, or null while it loads (or if it can't be). */
export function useAssetUrl(assetId: string): string | null {
  const [url, setUrl] = useState<{ id: string; url: string } | null>(null)
  useEffect(() => {
    let entry = pictures.get(assetId)
    if (!entry) {
      const made = valueOf(window.universe.getAsset(assetId)).then(({ mime, data }) => URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: mime })))
      entry = { url: made, users: 0 }
      pictures.set(assetId, entry)
      made.catch(() => pictures.delete(assetId))
    }
    entry.users++
    let live = true
    entry.url.then(
      (u) => live && setUrl({ id: assetId, url: u }),
      () => live && setUrl(null)
    )
    const held = entry
    return () => {
      live = false
      if (--held.users > 0 || pictures.get(assetId) !== held) return
      pictures.delete(assetId)
      void held.url.then(
        (u) => URL.revokeObjectURL(u),
        () => {}
      )
    }
  }, [assetId])
  return url?.id === assetId ? url.url : null
}

// The file's bytes are the worker's from then on: a scene can be tens of megabytes.
const askWorker = workerCalls<BlendRequest, BlendReply>(
  () => new BlendWorker(),
  ({ bytes }) => [bytes.buffer as ArrayBuffer]
)
const read = async <T extends BlendReply>(assetId: string, what: BlendRequest['what']) => (await askWorker({ bytes: await valueOf(window.universe.getBlend(assetId)), what })) as T

const thumbnails = new Map<string, Promise<BlendThumbnail | null>>()
const scenes = new Map<string, Promise<BlendScene>>()
/** Scenes kept read: they can be large, and only the one in the viewer is drawn. */
const SCENES_KEPT = 2

/** `make`'s promise for `key`, made once and kept (the `keep` most recently asked for, if said); a failure isn't kept. */
function remembered<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>, keep = Infinity): Promise<T> {
  let value = cache.get(key)
  if (value) cache.delete(key)
  else {
    value = make()
    value.catch(() => cache.delete(key))
  }
  // Most recently asked last, so the oldest goes first.
  cache.set(key, value)
  while (cache.size > keep) cache.delete(cache.keys().next().value!)
  return value
}

export type Loading<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed'; error: string }

function useLoaded<T>(assetId: string, load: (id: string) => Promise<T>): Loading<T> {
  const [loaded, setLoaded] = useState<{ id: string; value: Loading<T> } | null>(null)
  useEffect(() => {
    let live = true
    load(assetId).then(
      (value) => live && setLoaded({ id: assetId, value: { state: 'ready', value } }),
      (e: unknown) => live && setLoaded({ id: assetId, value: { state: 'failed', error: e instanceof Error ? e.message : String(e) } })
    )
    return () => void (live = false)
  }, [assetId, load])
  return loaded?.id === assetId ? loaded.value : { state: 'loading' }
}

const loadThumbnail = (id: string) => remembered(thumbnails, id, () => read<BlendThumbnail | null>(id, 'thumbnail'))
const loadScene = (id: string) => remembered(scenes, id, () => read<BlendScene>(id, 'scene'), SCENES_KEPT)

/** The picture Blender saved at the front of a .blend file, if it did. */
export const useBlendThumbnail = (assetId: string) => useLoaded(assetId, loadThumbnail)
/** A .blend file's scene, read in a worker. */
export const useBlendScene = (assetId: string) => useLoaded(assetId, loadScene)

/** What the file picker offers: pictures and .blend files. */
export const MEDIA_ACCEPT = [...MEDIA_EXTENSIONS.image, ...MEDIA_EXTENSIONS.blend].map((e) => `.${e}`).join(',')

const asBase64 = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1))
    reader.onerror = () => reject(reader.error ?? new Error('That file couldn’t be read'))
    reader.readAsDataURL(file)
  })

/**
 * Keeps files on a character or an event: each read here (not in the main
 * process, so the phone app can too) and checked in the bus for what it is.
 * Several at once are one change, undone together.
 */
export async function attachFiles(to: MediaOwner, files: File[]): Promise<void> {
  const tooBig = files.find((f) => f.size > MAX_MEDIA_BYTES)
  const empty = files.find((f) => f.size === 0)
  if (tooBig || empty) {
    useUi.setState({ error: tooBig ? `${tooBig.name} is over ${MAX_MEDIA_BYTES / 1024 / 1024} MB` : `${empty!.name} is empty` })
    return
  }
  const commands = await Promise.all(
    files.map(async (file): Promise<Command> => ({ type: 'media.attach', payload: { to, assetId: crypto.randomUUID(), name: file.name, data: await asBase64(file) } }))
  )
  if (commands.length) await useUi.getState().execute(commands.length === 1 ? commands[0]! : { type: 'batch', payload: { commands } })
}
