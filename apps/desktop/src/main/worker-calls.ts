import type { Worker } from 'node:worker_threads'

/**
 * Calls to a worker thread of the main process, each answered by its id: the
 * worker is started at the first call, and one that fails or stops takes its
 * unanswered calls with it (the next call starts a new one).
 */
export interface WorkerCalls<Job> {
  call<T>(job: Job, transfer?: ArrayBuffer[]): Promise<T>
  stop(): void
}

export function workerCalls<Job extends object>(create: () => Worker): WorkerCalls<Job> {
  let worker: Worker | undefined
  const pending = new Map<number, { resolve(result: unknown): void; reject(err: Error): void }>()
  let nextId = 0
  const start = () => {
    const w = create()
    w.unref()
    w.on('message', ({ id, result, error }: { id: number; result?: unknown; error?: string }) => {
      const call = pending.get(id)
      pending.delete(id)
      if (error) call?.reject(new Error(error))
      else call?.resolve(result)
    })
    const fail = (err: Error) => {
      for (const call of pending.values()) call.reject(err)
      pending.clear()
      if (worker === w) worker = undefined
    }
    w.on('error', fail)
    w.on('exit', () => fail(new Error('A worker stopped')))
    return w
  }
  return {
    call<T>(job: Job, transfer: ArrayBuffer[] = []): Promise<T> {
      worker ??= start()
      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (result: unknown) => void, reject })
        worker!.postMessage({ id, ...job }, transfer)
      })
    },
    stop(): void {
      void worker?.terminate()
      worker = undefined
    }
  }
}
