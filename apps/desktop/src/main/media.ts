import { blendCompression, zstdFrames } from '@universe/core'
import { rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, zstdDecompress } from 'node:zlib'

const gunzipAsync = promisify(gunzip)
const zstdAsync = promisify(zstdDecompress)

/**
 * A .blend file's bytes as Blender wrote them before compressing them, for
 * the window's reader: inflated on libuv's threads (zstd's frames side by
 * side), not on the main process's.
 */
export async function inflateBlend(data: Uint8Array): Promise<Uint8Array> {
  switch (blendCompression(data)) {
    case 'gzip':
      return new Uint8Array(await gunzipAsync(data))
    case 'zstd':
      return new Uint8Array(Buffer.concat(await Promise.all(zstdFrames(data).map((f) => zstdAsync(data.subarray(f.start, f.start + f.length))))))
    default:
      return data
  }
}

/** A file name that stays in its folder, whatever the project called it. */
const safeName = (name: string) => basename(name).replace(/[<>:"/\\|?*\p{Cc}]/gu, '_') || 'file'

/**
 * Copies of the project's files opened with the system's apps (a .blend in
 * Blender), each in a folder of its own under `root`; cleared when the app
 * quits. They're copies: the project keeps its own.
 */
export class OpenedCopies {
  constructor(
    private readonly root: string,
    private readonly open: (path: string) => Promise<string>
  ) {}

  async show(id: string, name: string, data: Uint8Array): Promise<void> {
    const folder = join(this.root, safeName(id))
    await mkdir(folder, { recursive: true })
    const path = join(folder, safeName(name))
    await writeFile(path, data)
    const error = await this.open(path)
    if (error) throw new Error(`Nothing on this computer opens ${name}: ${error}`)
  }

  /** On the way out, so it's done before the app is. */
  clear(): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}
