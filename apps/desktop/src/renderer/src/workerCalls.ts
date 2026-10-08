/**
 * Calls into a Web Worker as promises (heavy generation runs in workers to
 * keep the UI responsive): each request carries an id, and the reply with the
 * same id resolves it. The worker starts on first use; if it fails, every
 * call waiting on it is rejected and the next call starts a fresh one.
 */
export function workerCalls<Request, Reply>(start: () => Worker): (request: Request) => Promise<Reply> {
  let worker: Worker | undefined
  let next = 0
  const waiting = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>()
  const fail = (error: Error) => {
    worker?.terminate()
    worker = undefined
    for (const call of waiting.values()) call.reject(error)
    waiting.clear()
  }
  return (request) => {
    if (!worker) {
      worker = start()
      worker.onmessage = (e: MessageEvent<{ id: number; reply?: Reply; error?: string }>) => {
        const call = waiting.get(e.data.id)
        waiting.delete(e.data.id)
        if (e.data.error === undefined) call?.resolve(e.data.reply as Reply)
        else call?.reject(new Error(e.data.error))
      }
      worker.onerror = (e) => fail(new Error(e.message || 'The worker stopped'))
      worker.onmessageerror = () => fail(new Error('A worker reply could not be read'))
    }
    const id = ++next
    const done = new Promise<Reply>((resolve, reject) => waiting.set(id, { resolve, reject }))
    worker.postMessage({ id, request })
    return done
  }
}

/** Inside a worker: answers each call with `handle`, handing over (not copying) the buffers it lists; a throw rejects just that call. */
export function answerCalls<Request, Reply>(handle: (request: Request) => { reply: Reply; transfer: ArrayBufferLike[] }) {
  const scope = self as unknown as Worker
  scope.onmessage = (e: MessageEvent<{ id: number; request: Request }>) => {
    try {
      const { reply, transfer } = handle(e.data.request)
      scope.postMessage({ id: e.data.id, reply }, transfer as Transferable[])
    } catch (error) {
      scope.postMessage({ id: e.data.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
