import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CardUrl } from '@universe/core'
import { rng } from '@universe/procgen'
import { BrowserWindow, Menu, app, dialog, ipcMain, session as electronSession, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type OpenDialogOptions, type SaveDialogOptions, type WebFrameMain } from 'electron'
import { appFolder, isAllowedRequest } from '../shared/offline'
import { EVENTS, INVOKE, type AppState, type BuildInfo, type ImportedModel, type InvokeMethod, type MenuAction, type RemoteMethod, type Result, type UniverseApi } from '../shared/api'
import type { ApiController } from './api'
import type { Session } from './session'
import { OpenedCopies, inflateBlend } from './media'
import { TAILNET_URLS } from './tailnet'
import { CHANNELS, versionLabel } from '../shared/update'
import { Updater } from './updater'

declare const __BUILD_INFO__: BuildInfo

const isMac = process.platform === 'darwin'
const FILE_FILTERS = [{ name: 'Universe Project', extensions: ['universe'] }]

/** "Universe", or "Universe (dev)" and "Universe (staging)" for those branches' builds: apps of their own. */
const APP_NAME = CHANNELS[__BUILD_INFO__.channel].name

// Lets tests (and power users) keep app data somewhere other than the default profile; otherwise each channel keeps its own.
if (process.env.UNIVERSE_USER_DATA) app.setPath('userData', process.env.UNIVERSE_USER_DATA)
else if (app.getName() !== APP_NAME) app.setPath('userData', join(app.getPath('appData'), APP_NAME))

// One app per profile: a second one (a .universe file double-clicked) hands its file to this one and quits, so two never serve or write the same project.
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()
app.on('second-instance', (_event, argv, workingDirectory) => {
  if (win?.isMinimized()) win.restore()
  win?.focus()
  // A path relative to where the second one was started, not this one.
  const file = argv.find((a) => a.endsWith('.universe'))
  if (file) void opened(resolve(workingDirectory, file))
})
// End-to-end tests pick their universe: every random seed drawn here (a new universe's, each new node's) comes from this one.
if (process.env.UNIVERSE_E2E_SEED) Math.random = rng(Number(process.env.UNIVERSE_E2E_SEED))

let win: BrowserWindow | null = null
/** Copies of the project's files opened in other apps (a .blend in Blender). */
const copies = new OpenedCopies(join(app.getPath('temp'), `${APP_NAME} files`), (path) => shell.openPath(path))
/** Set once the project code has loaded, just after the first window is created. API calls wait for `loaded`. */
let session: Session
/** The local API for AI clients (PLAN.md §6); set up with the session. */
let api: ApiController
let plugins: Promise<import('./plugins').Plugins> | undefined
let markLoaded!: () => void
const loaded = new Promise<void>((resolve) => (markLoaded = resolve))
/** The spelling dictionary, loaded the first time it's asked (it takes a moment to read). */
let spelling: Promise<import('./dictionary').Dictionary> | undefined
const dictionary = () => (spelling ??= import('./dictionary').then(({ Dictionary }) => new Dictionary(app.getPath('userData'))))

const updater = new Updater(__BUILD_INFO__.channel, (status) => win?.webContents.send(EVENTS.update, status))
/** A .universe file passed on the command line or via Finder before the window was ready. */
let pendingOpen: string | undefined = process.argv.find((a) => a.endsWith('.universe'))

/** The dev server, in development only (a packaged app never loads anything but its own files). */
const devServer = !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL) : undefined
/** The app's renderer: its page and the files that page loads. */
const RENDERER_DIR = join(__dirname, '../renderer')
/** The app's own page: the only one its window shows, and the only one the main process answers. */
const appPage = devServer ?? pathToFileURL(join(RENDERER_DIR, 'index.html'))
/** Whether a URL is the app's page (its hash and query aside). */
const isAppPage = (url: string) => {
  try {
    const u = new URL(url)
    return u.origin === appPage.origin && (devServer ? true : u.pathname === appPage.pathname)
  } catch {
    return false
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0e17',
    // Only a window made again (macOS) has a project to name.
    title: session ? windowTitle(session.state()) : APP_TITLE,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The app's own dictionary checks spelling (dictionary.ts, through the preload), the same everywhere and offline.
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  // The title names the open project, so the page's own <title> mustn't replace it on a reload.
  win.on('page-title-updated', (event) => event.preventDefault())
  win.on('closed', () => (win = null))
  // A web page (a link in a note, a canvas's link card) opens in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebPage(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Nothing (a link in a note, a file dropped on the window, a frame) turns the window into another page, which would get the app's bridge.
  const stay = (event: { preventDefault(): void }, url: string) => {
    if (isAppPage(url)) return
    event.preventDefault()
    if (isWebPage(url)) void shell.openExternal(url)
  }
  win.webContents.on('will-navigate', stay)
  win.webContents.on('will-frame-navigate', (event) => stay(event, event.url))
  // WebRTC can send packets that no request filter sees: none that bypass a proxy, and the app has none.
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')

  void win.loadURL(appPage.href)

  if (pendingOpen) {
    const path = pendingOpen
    pendingOpen = undefined
    win.webContents.once('did-finish-load', () => void opened(path))
  }
}

/** Opens a file the system handed over, once the project code has loaded. */
async function opened(path: string): Promise<void> {
  await loaded
  const result = await wrap(() => openProject(path))
  if (result.ok) push(result.value)
}

/** Sends state the renderer didn't ask for: after a menu item, or a file opened from the system. */
function push(state: AppState | null): void {
  if (!state) return
  win?.webContents.send(EVENTS.state, state)
  api?.toPhones('state', state)
}

/** The window's title, the version always in it beside the app's name: "Terra — Universe 0.1.72 (Dev)". */
const APP_TITLE = `Universe ${versionLabel(__BUILD_INFO__)}`
const windowTitle = (state: AppState) => (state.project ? `${state.project.name} — ${APP_TITLE}` : APP_TITLE)

/**
 * The title and the menu (recent files, what's enabled) only change when a
 * project opens or closes, so they're refreshed then rather than after every command.
 */
function switchedTo(state: AppState): AppState {
  win?.setTitle(windowTitle(state))
  buildMenu()
  api.projectChanged()
  return state
}

async function wrap<T>(fn: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** A file (or folder) the user picks to open, or null if they cancel. */
async function pickToOpen(options: OpenDialogOptions): Promise<string | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(win!, options)
  return canceled ? null : (filePaths[0] ?? null)
}

/** Where the user saves a file, or null if they cancel. */
async function pickToSave(options: SaveDialogOptions): Promise<string | null> {
  const { canceled, filePath } = await dialog.showSaveDialog(win!, options)
  return canceled || !filePath ? null : filePath
}

/** Where the user saves a new universe file (with the extension added if they left it off), or null if they cancel. */
async function savePath(title: string, buttonLabel: string, name: string): Promise<string | null> {
  const filePath = await pickToSave({ title, buttonLabel, defaultPath: join(app.getPath('documents'), `${name}.universe`), filters: FILE_FILTERS })
  if (!filePath) return null
  return filePath.endsWith('.universe') ? filePath : `${filePath}.universe`
}

async function newProject(): Promise<AppState | null> {
  const path = await savePath('Create a new universe', 'Create', 'My Universe')
  return path ? switchedTo(session.create(path)) : null
}

/** The sample universe (packages/api/src/sample.ts), in a new file of the user's. */
async function newSample(): Promise<AppState | null> {
  const path = await savePath('Save the sample universe', 'Save and open', 'Calder (sample)')
  return path ? switchedTo(await session.createSample(path)) : null
}

/** A copy here of the universe another device has open (PLAN.md §6.7: one of the user's own, or another person's shared with them), saved where they pick, and opened. */
async function copyFromDevice(host: string): Promise<AppState | null> {
  const open = api.devices.openOn(host)
  if (!open) throw new Error('That device has no universe open now')
  const path = await savePath(`Copy “${open.project.name}” from ${open.device}`, 'Copy here', open.project.name)
  if (!path) return null
  api.opening(path)
  return switchedTo(await api.copyFromDevice(host, path))
}

async function openProject(path?: string): Promise<AppState | null> {
  path ??= (await pickToOpen({ title: 'Open a universe', properties: ['openFile'], filters: FILE_FILTERS })) ?? undefined
  if (!path) return null
  // An AI client's MCP server may have the file open for a moment: it's told the app is opening it, and let go of.
  const { waitForUnlock } = await import('@universe/api')
  api.opening(path)
  try {
    if (!(await waitForUnlock(path))) throw new Error('An AI client is using this project right now. Try again in a moment')
    return switchedTo(session.open(path))
  } catch (err) {
    api.projectChanged()
    throw err
  }
}

async function saveCopy(): Promise<void> {
  const filePath = await pickToSave({ title: 'Save a copy', buttonLabel: 'Save Copy', defaultPath: session.path?.replace(/\.universe$/, ' copy.universe'), filters: FILE_FILTERS })
  if (!filePath) return
  await session.saveCopy(filePath)
  // The copy is now a recent file.
  buildMenu()
}

const MAX_MODEL_BYTES = 64 * 1024 * 1024

/** Asks for a glTF model (.glb, or .gltf with everything embedded: external files aren't followed) and keeps it in the project. */
async function importModel(): Promise<ImportedModel | null> {
  const path = await pickToOpen({ title: 'Import a 3D model', properties: ['openFile'], filters: [{ name: 'glTF model', extensions: ['glb', 'gltf'] }] })
  if (!path) return null
  if ((await stat(path)).size > MAX_MODEL_BYTES) throw new Error('That model is over 64 MB')
  const bytes = await readFile(path)
  const mime = path.toLowerCase().endsWith('.glb') ? 'model/gltf-binary' : 'model/gltf+json'
  const name = basename(path)
  return { name, ...session.addAsset(name, mime, bytes) }
}

/** Tells API clients the project changed, and passes the state on. */
function changed(state: AppState, summary: string): AppState {
  api.changedHere(summary)
  return state
}

/** The plugin manager (PLAN.md §9, M16), made the first time it's asked for. */
function pluginManager(): Promise<import('./plugins').Plugins> {
  plugins ??= import('./plugins').then(
    ({ Plugins }) =>
      new Plugins(app.getPath('userData'), {
        session,
        context: (write) => api.pluginContext(write),
        changed: (state, summary) => push(changed(state, summary)),
        dialogs: {
          folder: (title, buttonLabel) => pickToOpen({ title, buttonLabel, properties: ['openDirectory', 'createDirectory'] }),
          openFile: (title, extensions) => pickToOpen({ title, properties: ['openFile'], filters: extensions.length ? [{ name: 'Files', extensions }] : [] }),
          saveFile: (title, name) => pickToSave({ title, buttonLabel: 'Save', defaultPath: join(app.getPath('documents'), name) })
        },
        show: async (path) => void (await shell.openPath(path)),
        trash: (path) => shell.trashItem(path)
      })
  )
  return plugins
}

/** Asks where to save something (in the documents folder by default, named `name`) and writes it there; the path, or null if cancelled. */
async function exportTo(title: string, name: string, filter: { name: string; extension: string }, contents: () => Promise<string | Buffer>): Promise<string | null> {
  const filePath = await pickToSave({
    title,
    buttonLabel: 'Export',
    defaultPath: join(app.getPath('documents'), `${name.replace(/[\\/:*?"<>|]/g, '-')}.${filter.extension}`),
    filters: [{ name: filter.name, extensions: [filter.extension] }]
  })
  if (!filePath) return null
  await writeFile(filePath, await contents())
  return filePath
}

/** Asks where to save a world's bible and writes it there. */
const exportBible = (worldId: string) =>
  exportTo('Export the world bible', session.state().nodes.find((n) => n.id === worldId)?.name ?? 'World', { name: 'Markdown', extension: 'md' }, () => api.bible(worldId))

/** An address the browser is given to open: a web page (as a canvas's link card holds), nothing else (no files, no other apps' links). */
const isWebPage = (url: string) => CardUrl.safeParse(url).success

/** A PNG's first bytes. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** The biggest picture the window may hand over to save. */
const MAX_PNG_BYTES = 256 * 1024 * 1024

/** Saves a PNG the window drew (the canvas's picture of itself) where the user says. */
async function exportImage(png: unknown, name: string): Promise<string | null> {
  if (!(png instanceof Uint8Array) || png.length > MAX_PNG_BYTES || !PNG_SIGNATURE.every((b, i) => png[i] === b)) throw new Error('That isn’t a PNG picture')
  return exportTo('Export as an image', name, { name: 'PNG image', extension: 'png' }, async () => Buffer.from(png))
}

/** Menu-triggered actions that can fail show their error in a dialog, since there is no caller to return it to. */
function fromMenu(fn: () => Promise<unknown>): () => void {
  return () =>
    void fn().catch((err: Error) => {
      if (win) void dialog.showMessageBox(win, { type: 'error', message: 'Something went wrong', detail: err.message })
    })
}

function sendMenu(action: MenuAction): () => void {
  return () => win?.webContents.send(EVENTS.menu, action)
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
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Dictionary…', click: sendMenu('dictionary') }
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
      label: 'Tools',
      submenu: [{ label: 'Plugins…', click: sendMenu('plugins') }]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () =>
            void dialog.showMessageBox(win!, {
              message: `Universe ${versionLabel(__BUILD_INFO__)}`,
              detail: `Build ${__BUILD_INFO__.commit} (${__BUILD_INFO__.builtAt})\nElectron ${process.versions.electron}`
            })
        },
        { label: 'Change Version…', click: sendMenu('versions') },
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: sendMenu('shortcuts') },
        { label: 'Explore a Sample Universe…', click: fromMenu(async () => push(await newSample())) },
        { label: 'Project on GitHub', click: () => void shell.openExternal('https://github.com/Gabetd/universe.me') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** How the main process answers an API method: with its reply, or a promise of it. */
type Answer<M extends InvokeMethod> = (...args: Parameters<UniverseApi[M]>) => ReturnType<UniverseApi[M]> | Awaited<ReturnType<UniverseApi[M]>>

/** Whether a call comes from the app's own page in its own window (not a frame, or a page it was navigated to). */
const fromApp = (frame: WebFrameMain | null) => !!frame && frame === win?.webContents.mainFrame && isAppPage(frame.url)

/** Answers one API method; its arguments and reply are checked against `UniverseApi`. */
/** Every method's answer, for the window and (those it may ask) the phone app. */
const answers = new Map<InvokeMethod, (...args: unknown[]) => unknown>()

/** Methods that answer with the project's new state, which then goes to the others looking at it too. */
const CHANGES = new Set<InvokeMethod>(['execute', 'undo', 'redo', 'undoAi', 'acceptProposal', 'rejectProposal'])
const newState = (method: InvokeMethod, result: unknown) => (CHANGES.has(method) && (result as Result<AppState> | undefined)?.ok ? (result as { value: AppState }).value : undefined)

function handle<M extends InvokeMethod>(method: M, answer: Answer<M>): void {
  answers.set(method, answer as (...args: unknown[]) => unknown)
  ipcMain.handle(INVOKE[method], async (e: IpcMainInvokeEvent, ...args) => {
    if (!fromApp(e.senderFrame)) throw new Error('Only the app’s own page can ask this')
    await loaded
    const result = await answer(...(args as Parameters<UniverseApi[M]>))
    const state = newState(method, result)
    if (state) api.toPhones('state', state)
    return result
  })
}

/** A method asked by the phone app: answered as the window's would be, and the window (and other phones) shown what it changed. */
async function answerPhone(method: RemoteMethod, args: unknown[]): Promise<unknown> {
  await loaded
  const result = await answers.get(method)!(...args)
  const state = newState(method, result)
  if (state) {
    win?.webContents.send(EVENTS.state, state)
    api.toPhones('state', state)
  }
  return result
}

function registerIpc(): void {
  handle('getState', () => session.state())
  handle('recentProjects', () => session.recent())
  handle('newProject', () => wrap(newProject))
  handle('newSample', () => wrap(newSample))
  // A path from the window is one from the recent list (anything else is chosen in the system's own dialog).
  handle('openProject', (path) =>
    wrap(() => {
      if (path !== undefined && !session.recent().includes(path)) throw new Error('Open it with Open… first')
      return openProject(path)
    })
  )
  handle('getTerrain', (worldId) => wrap(() => session.terrain(worldId)))
  handle('importModel', () => wrap(importModel))
  handle('getAsset', (id) => wrap(() => session.asset(id)))
  handle('getBlend', (id) => wrap(() => inflateBlend(session.asset(id).data)))
  handle('openAsset', (id) =>
    wrap(() => {
      const { name, data } = session.asset(id)
      return copies.show(id, name, data)
    })
  )
  // Commands get the new state as the reply, so it isn't pushed as well; API clients hear of them on the change feed.
  handle('execute', (command) => wrap(() => changed(session.execute(command), `Changed in the app (${(command as { type?: string }).type ?? 'a command'})`)))
  handle('undo', () => wrap(() => changed(session.undo(), 'Undone in the app')))
  handle('redo', () => wrap(() => changed(session.redo(), 'Redone in the app')))
  handle('undoAi', () => wrap(() => changed(session.undoAi(), 'The AI’s latest changes undone in the app')))
  handle('acceptProposal', (id) => wrap(() => changed(session.accept(id), 'An AI suggestion accepted in the app')))
  handle('rejectProposal', (id) => wrap(() => session.reject(id)))
  handle('exportBible', (worldId) => wrap(() => exportBible(worldId)))
  handle('exportImage', (png, name) => wrap(() => exportImage(png, name)))
  // Tailscale is looked at again each time Connect AI opens; what it finds comes as a status event.
  handle('apiStatus', () => {
    void api.syncPhone()
    return api.status()
  })
  handle('setApi', (patch) => api.set(patch))
  handle('newApiToken', () => api.newToken())
  handle('denySignIn', (id) => api.denySignIn(id))
  handle('removeConnection', (id) => api.removeConnection(id))
  handle('copyFromDevice', (host) => wrap(() => copyFromDevice(host)))
  handle('collaboration', () => api.devices.collaboration())
  handle('setWhere', (where) => api.devices.setWhere(where))
  handle('updateStatus', () => updater.current())
  handle('installUpdate', () => updater.install())
  handle('dismissUpdate', () => updater.dismiss())
  handle('checkForUpdates', () => updater.check(true))
  handle('versions', () => updater.versions())
  handle('installVersion', (channel) => updater.installBeside(channel))
  handle('spellCheck', async (words) => (await dictionary()).misspelled(words.filter((w) => typeof w === 'string').slice(0, 2000)))
  handle('spellWord', async (word) => (await dictionary()).check(String(word)))
  handle('dictionaryWords', async () => (await dictionary()).words())
  handle('addWord', async (word) => (await dictionary()).add(String(word)))
  handle('removeWord', async (word) => (await dictionary()).remove(String(word)))
  handle('setSpellingNames', async (names) => (await dictionary()).setNames(names.filter((n) => typeof n === 'string')))
  handle('paste', () => win?.webContents.paste())
  handle('plugins', async () => (await pluginManager()).list())
  handle('addPlugin', () => wrap(async () => (await pluginManager()).add()))
  handle('newPlugin', () => wrap(async () => (await pluginManager()).create()))
  handle('removePlugin', (id) => wrap(async () => (await pluginManager()).remove(String(id))))
  handle('setPluginEnabled', async (id, enabled) => (await pluginManager()).setEnabled(String(id), !!enabled))
  handle('showPlugin', async (id) => (await pluginManager()).show(String(id)))
  handle('runPlugin', (request) => wrap(async () => (await pluginManager()).run(request)))
}

// macOS delivers double-clicked files through this event, possibly before `ready`.
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (win) void opened(path)
  else pendingOpen = path
})

/** Nothing leaves this computer: every request but the app's own files (and the update download) is cancelled. */
function keepOffline(): void {
  const extra = [devServer?.href, process.env.UNIVERSE_UPDATE_URL, ...Object.values(TAILNET_URLS)]
    .filter((u): u is string => !!u && u !== 'off')
    .map((u) => new URL(u).origin + '/')
  // Dev server hot reload uses a websocket on the same host.
  if (devServer) extra.push(`ws://${devServer.host}/`)
  // The app's files: its renderer folder (inside its archive when packaged), and nothing else on disk or another computer.
  const files = appFolder(pathToFileURL(RENDERER_DIR).href + '/')
  const defaults = electronSession.defaultSession
  defaults.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedRequest(details.url, details.webContentsId !== undefined, extra, files)
    if (!allowed) console.warn(`Blocked a network request to ${details.url}`)
    callback({ cancel: !allowed })
  })
  // No camera, microphone, location, notifications or devices: nothing the app uses. Only writing to the clipboard (Copy buttons).
  const allowedPermission = (permission: string) => permission === 'clipboard-sanitized-write'
  defaults.setPermissionRequestHandler((_wc, permission, callback) => callback(allowedPermission(permission)))
  defaults.setPermissionCheckHandler((_wc, permission) => allowedPermission(permission))
  defaults.setDevicePermissionHandler(() => false)
}

app.whenReady().then(async () => {
  if (!primary) return
  keepOffline()
  registerIpc()
  createWindow()
  // Evaluating core, db and zod takes a while, so it happens while the window loads rather than before.
  const [{ Session }, { ApiController }] = await Promise.all([import('./session'), import('./api')])
  session = new Session(app.getPath('userData'))
  api = new ApiController(app.getPath('userData'), session, {
    state: (state) => {
      win?.webContents.send(EVENTS.state, state)
      api.toPhones('state', state)
    },
    aiChange: (change) => {
      win?.webContents.send(EVENTS.aiChange, change)
      api.toPhones('aiChange', change)
    },
    status: (status) => win?.webContents.send(EVENTS.api, status),
    collaboration: (collaboration) => win?.webContents.send(EVENTS.collaboration, collaboration)
  }, __BUILD_INFO__.version)
  // The phone app serves the window's own built files (in development the window comes from the dev server, and there's no phone app).
  if (!devServer) api.useBridge({ files: RENDERER_DIR, answer: answerPhone })
  // Without the API the app still works: Connect AI says why it isn't listening.
  await api.start().catch((err: Error) => console.error(`The API didn't start: ${err.message}`))
  markLoaded()
  buildMenu()
  updater.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('will-quit', () => {
  api?.close()
  session?.close()
  copies.clear()
})
