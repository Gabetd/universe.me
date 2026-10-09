import { INVOKE, isRemoteMethod, type AiChange, type AppState, type InvokeMethod, type UniverseApi } from '../../shared/api'
import { fromWire, toWire } from '../../shared/wire'

/**
 * The window's bridge in the phone app (PLAN.md §6.6), where there's no
 * Electron preload: the computer serves this page, answers the same methods
 * over HTTP (those it lets a phone ask) and sends its events as a stream.
 * What's only for the computer (files and dialogs there, the API's settings,
 * updates) isn't asked: it answers as if there were nothing to show, or says
 * it's for the computer.
 */

/** Answers for what a phone doesn't ask the computer. */
const ON_THE_PHONE: Partial<Record<InvokeMethod, () => unknown>> = {
  recentProjects: () => [],
  updateStatus: () => ({ state: 'none' }),
  checkForUpdates: () => 'Updates are installed on the computer.'
}

async function call(method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`/bridge/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: toWire(args), credentials: 'same-origin' })
  // Signed out (removed on the computer, or gone too long): the page starts over at signing in.
  if (res.status === 401) {
    location.reload()
    return new Promise(() => {})
  }
  const text = await res.text()
  if (!res.ok) throw new Error((JSON.parse(text) as { error?: string }).error ?? `The computer answered ${res.status}`)
  return fromWire(text)
}

type Listener<T> = (value: T) => void

export function installWebBridge(): void {
  const listeners = { state: new Set<Listener<AppState>>(), aiChange: new Set<Listener<AiChange>>() }
  const events = new EventSource('/bridge/events')
  for (const name of ['state', 'aiChange'] as const) {
    events.addEventListener(name, (e) => {
      const value = fromWire((e as MessageEvent<string>).data)
      for (const listener of listeners[name]) (listener as Listener<unknown>)(value)
    })
  }
  // Back after the connection dropped: whatever changed meanwhile.
  let opened = false
  events.addEventListener('open', () => {
    if (opened) void call('getState', []).then((state) => listeners.state.forEach((l) => l(state as AppState)))
    opened = true
  })
  const subscribe =
    <T>(set: Set<Listener<T>>) =>
    (listener: Listener<T>) => {
      set.add(listener)
      return () => void set.delete(listener)
    }
  const invokers = Object.fromEntries(
    (Object.keys(INVOKE) as InvokeMethod[]).map((method) => [
      method,
      isRemoteMethod(method) ? (...args: unknown[]) => call(method, args) : async () => (ON_THE_PHONE[method] ? ON_THE_PHONE[method]() : Promise.reject(new Error('That’s done on the computer')))
    ])
  ) as unknown as Pick<UniverseApi, InvokeMethod>
  const api: UniverseApi = {
    ...invokers,
    remote: true,
    onState: subscribe(listeners.state),
    onAiChange: subscribe(listeners.aiChange),
    onMenu: () => () => {},
    onUpdate: () => () => {},
    onApi: () => () => {}
  }
  Object.defineProperty(window, 'universe', { value: api })
}

/** Whether this is the phone app (the computer's window, in a phone's browser). */
export const isPhoneApp = () => !!window.universe?.remote
