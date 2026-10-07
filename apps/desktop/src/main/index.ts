import { join } from 'node:path'
import { BrowserWindow, Menu, app, dialog, ipcMain, shell, type MenuItemConstructorOptions } from 'electron'
import { IPC, type AppState, type BuildInfo, type MenuAction, type Result } from '../shared/api'
import { Session } from './session'

declare const __BUILD_INFO__: BuildInfo

const isMac = process.platform === 'darwin'
const FILE_FILTERS = [{ name: 'Universe Project', extensions: ['universe'] }]

// Lets tests (and power users) keep app data somewhere other than the default profile.
if (process.env.UNIVERSE_USER_DATA) app.setPath('userData', process.env.UNIVERSE_USER_DATA)

let win: BrowserWindow | null = null
let session: Session
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
    title: 'Universe',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => (win = null))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  if (pendingOpen) {
    const path = pendingOpen
    pendingOpen = undefined
    win.webContents.once('did-finish-load', () => void wrap(() => session.open(path)).then(() => broadcast()))
  }
}

/** Pushes new state to the renderer (for changes it didn't ask for) and refreshes the window chrome. */
function broadcast(state: AppState = session.state()): void {
  win?.webContents.send(IPC.stateChanged, state)
  refreshChrome(state)
}

function refreshChrome(state: AppState): void {
  win?.setTitle(state.project ? `${state.project.name} — Universe` : 'Universe')
  buildMenu()
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
  const state = session.create(path)
  broadcast(state)
  return state
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
  const state = session.open(path)
  broadcast(state)
  return state
}

async function saveCopy(): Promise<string | null> {
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    title: 'Save a copy',
    buttonLabel: 'Save Copy',
    defaultPath: session.state().project?.path.replace(/\.universe$/, ' copy.universe'),
    filters: FILE_FILTERS
  })
  if (canceled || !filePath) return null
  session.saveCopy(filePath)
  buildMenu()
  return filePath
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
        { label: 'New Universe…', accelerator: 'CmdOrCtrl+N', click: fromMenu(newProject) },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: fromMenu(() => openProject()) },
        {
          label: 'Open Recent',
          enabled: recent.length > 0,
          submenu: recent.map((p) => ({ label: p, click: fromMenu(() => openProject(p)) }))
        },
        { type: 'separator' },
        { label: 'Save a Copy…', accelerator: 'CmdOrCtrl+Shift+S', enabled: open, click: fromMenu(saveCopy) },
        {
          label: 'Close Project',
          enabled: open,
          click: () => {
            session.close()
            broadcast()
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
  ipcMain.handle(IPC.closeProject, () => {
    session.close()
    broadcast()
    return session.state()
  })
  for (const [channel, run] of [
    [IPC.execute, (cmd: unknown) => session.execute(cmd)],
    [IPC.undo, () => session.undo()],
    [IPC.redo, () => session.redo()]
  ] as const) {
    ipcMain.handle(channel, (_e, cmd: unknown) =>
      wrap(() => {
        // The renderer gets the state as the reply, so don't also push it.
        const state = run(cmd)
        refreshChrome(state)
        return state
      })
    )
  }
}

// macOS delivers double-clicked files through this event, possibly before `ready`.
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (win && session) void wrap(() => openProject(path))
  else pendingOpen = path
})

app.whenReady().then(() => {
  session = new Session(app.getPath('userData'))
  registerIpc()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('will-quit', () => session?.close())
