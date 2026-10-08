/**
 * Calls into a Web Worker as promises (heavy generation runs in workers to
 * keep the UI responsive): each request carries an id, and the reply with the
 * same id resolves it. The worker starts on first use.
 */
export function workerCalls<Request, Reply>(start: () => Worker): (request: Request) => Promise<Reply> {
  let worker: Worker | undefined
  let next = 0
  const waiting = new Map<number, (reply: Reply) => void>()
  return (request) => {
    if (!worker) {
      worker = start()
      worker.onmessage = (e: MessageEvent<{ id: number; reply: Reply }>) => {
        waiting.get(e.data.id)?.(e.data.reply)
        waiting.delete(e.data.id)
      }
    }
    const id = ++next
    const done = new Promise<Reply>((resolve) => waiting.set(id, resolve))
    worker.postMessage({ id, request })
    return done
  }
}

/** Inside a worker: answers each call with `handle`, handing over (not copying) the buffers it lists. */
export function answerCalls<Request, Reply>(handle: (request: Request) => { reply: Reply; transfer: ArrayBufferLike[] }) {
  const scope = self as unknown as Worker
  scope.onmessage = (e: MessageEvent<{ id: number; request: Request }>) => {
    const { reply, transfer } = handle(e.data.request)
    scope.postMessage({ id: e.data.id, reply }, transfer as Transferable[])
  }
}
