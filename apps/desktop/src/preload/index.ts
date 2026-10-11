import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from 'electron'
import { EVENTS, INVOKE, type AiChange, type ApiStatus, type AppState, type InvokeMethod, type MenuAction, type UniverseApi } from '../shared/api'
import type { UpdateStatus } from '../shared/update'

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

/** Every method the main process answers, one per channel in the table. */
const invokers = Object.fromEntries(
  Object.entries(INVOKE).map(([method, channel]) => [method, (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)])
) as Pick<UniverseApi, InvokeMethod>

/** Words already checked, and whether they're spelled right: the page asks again each time a field is drawn. Forgotten when the dictionary changes. */
const checked = new Map<string, boolean>()
const forgetting =
  <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
  (...args: A) =>
    call(...args).finally(() => checked.clear())

const api: UniverseApi = {
  ...invokers,
  addWord: forgetting(invokers.addWord),
  removeWord: forgetting(invokers.removeWord),
  setSpellingNames: forgetting(invokers.setSpellingNames),
  onState: (listener) => subscribe<AppState>(EVENTS.state, listener),
  onMenu: (listener) => subscribe<MenuAction>(EVENTS.menu, listener),
  onUpdate: (listener) => subscribe<UpdateStatus>(EVENTS.update, listener),
  onApi: (listener) => subscribe<ApiStatus>(EVENTS.api, listener),
  onAiChange: (listener) => subscribe<AiChange>(EVENTS.aiChange, listener)
}

contextBridge.exposeInMainWorld('universe', api)

// Words typed in the page are checked by the app's own dictionary (main/dictionary.ts), which underlines the misspelled ones.
webFrame.setSpellCheckProvider('en-US', {
  spellCheck: (words, done) => {
    const unknown = words.filter((w) => !checked.has(w))
    const misspelled = () => words.filter((w) => checked.get(w) === false)
    if (!unknown.length) return done(misspelled())
    void api.spellCheck(unknown).then(
      (wrong) => {
        const bad = new Set(wrong)
        for (const w of unknown) checked.set(w, !bad.has(w))
        done(misspelled())
      },
      () => done([])
    )
  }
})
