import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BrowserWindow, Menu, app, dialog, ipcMain, session as electronSession, shell, type MenuItemConstructorOptions } from 'electron'
import { isAllowedRequest } from '../shared/offline'
import { IPC, type AppState, type BuildInfo, type ImportedModel, type MenuAction, type Result } from '../shared/api'
import { Session } from './session'
import { Updater } from './updater'

declare const __BUILD_INFO__: BuildInfo

const isMac = process.platform === 'darwin'
const FILE_FILTERS = [{ name: 'Universe Project', extensions: ['universe'] }]

// Lets tests (and power users) keep app data somewhere other than the default profile.
if (process.env.UNIVERSE_USER_DATA) app.setPath('userData', process.env.UNIVERSE_USER_DATA)

let win: BrowserWindow | null = null
let session: Session
const updater = new Updater((status) => win?.webContents.send(IPC.updateChanged, status))
/** A .universe file passed on the command line or via Finder before the window was ready. */
let pendingOpen: string | undefined = process.argv.find((a) => a.endsWith('.universe'))

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0e17',
    title: windowTitle(session.state()),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  // The title names the open project, so the page's own <title> mustn't replace it on a reload.
  win.on('page-title-updated', (event) => event.preventDefault())
  win.on('closed', () => (win = null))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // A link in a note must never turn the app window into a web page.
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file:') || (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))) return
    event.preventDefault()
    if (url.startsWith('https://')) void shell.openExternal(url)
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  if (pendingOpen) {
    const path = pendingOpen
    pendingOpen = undefined
    win.webContents.once('did-finish-load', () => void wrap(() => openProject(path)).then((r) => r.ok && push(r.value)))
  }
}

/** Sends state the renderer didn't ask for: after a menu item, or a file opened from the system. */
function push(state: AppState | null): void {
  if (state) win?.webContents.send(IPC.stateChanged, state)
}

const windowTitle = (state: AppState) => (state.project ? `${state.project.name} — Universe` : 'Universe')

/**
 * The title and the menu (recent files, what's enabled) only change when a
 * project opens or closes, so they're refreshed then rather than after every command.
 */
function switchedTo(state: AppState): AppState {
  win?.setTitle(windowTitle(state))
  buildMenu()
  return state
}

async function wrap<T>(fn: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function newProject(): Promise<AppState | null> {
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    title: 'Create a new universe',
    buttonLabel: 'Create',
    defaultPath: join(app.getPath('documents'), 'My Universe.universe'),
    filters: FILE_FILTERS
  })
  if (canceled || !filePath) return null
  const path = filePath.endsWith('.universe') ? filePath : `${filePath}.universe`
  return switchedTo(session.create(path))
}

async function openProject(path?: string): Promise<AppState | null> {
  if (!path) {
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: 'Open a universe',
      properties: ['openFile'],
      filters: FILE_FILTERS
    })
    if (canceled || !filePaths[0]) return null
    path = filePaths[0]
  }
  return switchedTo(session.open(path))
}

async function saveCopy(): Promise<string | null> {
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    title: 'Save a copy',
    buttonLabel: 'Save Copy',
    defaultPath: session.path?.replace(/\.universe$/, ' copy.universe'),
    filters: FILE_FILTERS
  })
  if (canceled || !filePath) return null
  session.saveCopy(filePath)
  // The copy is now a recent file.
  buildMenu()
  return filePath
}

const MAX_MODEL_BYTES = 64 * 1024 * 1024

/** Asks for a glTF model (.glb, or .gltf with everything embedded: external files aren't followed) and keeps it in the project. */
async function importModel(): Promise<ImportedModel | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    title: 'Import a 3D model',
    properties: ['openFile'],
    filters: [{ name: 'glTF model', extensions: ['glb', 'gltf'] }]
  })
  if (canceled || !filePaths[0]) return null
  const path = filePaths[0]
  if ((await stat(path)).size > MAX_MODEL_BYTES) throw new Error('That model is over 64 MB')
  const bytes = await readFile(path)
  const mime = path.toLowerCase().endsWith('.glb') ? 'model/gltf-binary' : 'model/gltf+json'
  const name = basename(path)
  return { name, ...session.addAsset(name, mime, bytes) }
}

/** Menu-triggered actions that can fail show their error in a dialog, since there is no caller to return it to. */
function fromMenu(fn: () => Promise<unknown>): () => void {
  return () =>
    void fn().catch((err: Error) => {
      if (win) void dialog.showMessageBox(win, { type: 'error', message: 'Something went wrong', detail: err.message })
    })
}

function sendMenu(action: MenuAction): () => void {
  return () => win?.webContents.send(IPC.menu, action)
}

function buildMenu(): void {
  const open = session.isOpen
  const recent = session.recent()
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Universe…', accelerator: 'CmdOrCtrl+N', click: fromMenu(async () => push(await newProject())) },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: fromMenu(async () => push(await openProject())) },
        {
          label: 'Open Recent',
          enabled: recent.length > 0,
          submenu: recent.map((p) => ({ label: p, click: fromMenu(async () => push(await openProject(p))) }))
        },
        { type: 'separator' },
        { label: 'Save a Copy…', accelerator: 'CmdOrCtrl+Shift+S', enabled: open, click: fromMenu(saveCopy) },
        {
          label: 'Close Project',
          enabled: open,
          click: () => {
            session.close()
            push(switchedTo(session.state()))
          }
        },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        // Undo/redo go to the renderer first, so text fields keep their own undo.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: sendMenu('undo') },
        { label: 'Redo', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: sendMenu('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Universe',
          click: () =>
            void dialog.showMessageBox(win!, {
              message: `Universe ${__BUILD_INFO__.version}`,
              detail: `Build ${__BUILD_INFO__.commit} (${__BUILD_INFO__.builtAt})\nElectron ${process.versions.electron}`
            })
        },
        {
          label: 'Check for Updates…',
          click: fromMenu(async () => {
            const why = await updater.check(true)
            if (why && win) await dialog.showMessageBox(win, { message: why })
          })
        },
        { label: 'Project on GitHub', click: () => void shell.openExternal('https://github.com/Gabetd/universe.me') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(): void {
  ipcMain.handle(IPC.getState, () => session.state())
  ipcMain.handle(IPC.recent, () => session.recent())
  ipcMain.handle(IPC.newProject, () => wrap(newProject))
  ipcMain.handle(IPC.openProject, (_e, path?: string) => wrap(() => openProject(path)))
  ipcMain.handle(IPC.saveCopy, () => wrap(saveCopy))
  ipcMain.handle(IPC.terrain, (_e, worldId: string) => wrap(() => session.terrain(worldId)))
  ipcMain.handle(IPC.importModel, () => wrap(importModel))
  ipcMain.handle(IPC.getAsset, (_e, id: string) => wrap(() => session.asset(id)))
  ipcMain.handle(IPC.updateStatus, () => updater.current())
  ipcMain.handle(IPC.installUpdate, () => updater.install())
  ipcMain.handle(IPC.dismissUpdate, () => updater.dismiss())
  ipcMain.handle(IPC.closeProject, () => {
    session.close()
    push(switchedTo(session.state()))
    return session.state()
  })
  for (const [channel, run] of [
    [IPC.execute, (cmd: unknown) => session.execute(cmd)],
    [IPC.undo, () => session.undo()],
    [IPC.redo, () => session.redo()]
  ] as const) {
    // The renderer gets the state as the reply, so it isn't pushed as well.
    ipcMain.handle(channel, (_e, cmd: unknown) => wrap(() => run(cmd)))
  }
}

// macOS delivers double-clicked files through this event, possibly before `ready`.
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (win && session) void wrap(() => openProject(path)).then((r) => r.ok && push(r.value))
  else pendingOpen = path
})

/** Nothing leaves this computer: every request but the app's own files (and the update download) is cancelled. */
function keepOffline(): void {
  const extra = [process.env.ELECTRON_RENDERER_URL, process.env.UNIVERSE_UPDATE_URL]
    .filter((u): u is string => !!u && u !== 'off')
    .map((u) => new URL(u).origin + '/')
  // Dev server hot reload uses a websocket on the same host.
  if (process.env.ELECTRON_RENDERER_URL) extra.push(process.env.ELECTRON_RENDERER_URL.replace(/^http/, 'ws'))
  electronSession.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedRequest(details.url, details.webContentsId !== undefined, extra)
    if (!allowed) console.warn(`Blocked a network request to ${details.url}`)
    callback({ cancel: !allowed })
  })
}

app.whenReady().then(() => {
  keepOffline()
  session = new Session(app.getPath('userData'))
  registerIpc()
  buildMenu()
  createWindow()
  updater.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('will-quit', () => session?.close())
