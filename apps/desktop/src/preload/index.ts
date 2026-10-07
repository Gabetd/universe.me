import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type AppState, type MenuAction, type UniverseApi } from '../shared/api'

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: UniverseApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  recentProjects: () => ipcRenderer.invoke(IPC.recent),
  newProject: () => ipcRenderer.invoke(IPC.newProject),
  openProject: (path) => ipcRenderer.invoke(IPC.openProject, path),
  saveCopy: () => ipcRenderer.invoke(IPC.saveCopy),
  closeProject: () => ipcRenderer.invoke(IPC.closeProject),
  execute: (command) => ipcRenderer.invoke(IPC.execute, command),
  undo: () => ipcRenderer.invoke(IPC.undo),
  redo: () => ipcRenderer.invoke(IPC.redo),
  onState: (listener) => subscribe<AppState>(IPC.stateChanged, listener),
  onMenu: (listener) => subscribe<MenuAction>(IPC.menu, listener)
}

contextBridge.exposeInMainWorld('universe', api)
