import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
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

const api: UniverseApi = {
  ...invokers,
  onState: (listener) => subscribe<AppState>(EVENTS.state, listener),
  onMenu: (listener) => subscribe<MenuAction>(EVENTS.menu, listener),
  onUpdate: (listener) => subscribe<UpdateStatus>(EVENTS.update, listener),
  onApi: (listener) => subscribe<ApiStatus>(EVENTS.api, listener),
  onAiChange: (listener) => subscribe<AiChange>(EVENTS.aiChange, listener)
}

contextBridge.exposeInMainWorld('universe', api)
