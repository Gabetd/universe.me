import type { IncomingMessage, ServerResponse } from 'node:http'
import { ApiError } from './host'

/** Sends JSON (or, with another type, text as it is), never cached. */
export function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const text = typeof body === 'string' && !type.startsWith('application/json') ? body : JSON.stringify(body, null, 2)
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(text)
}

/** A request's body as text, up to `limit` bytes. */
export async function readText(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new ApiError(413, 'The request is too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** A JSON body (nothing reads as `{}`). */
export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const text = await readText(req, limit)
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError(400, 'The body is not JSON')
  }
}
