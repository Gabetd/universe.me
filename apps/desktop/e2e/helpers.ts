import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, test as base, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { AppState } from '../src/shared/api'

const CI = !!process.env.CI
/** For the slow waits (generating terrain, loading the ground, an update): CI machines draw in software. */
export const SLOW = CI ? 60_000 : 30_000
/** Starting the app: the first launch on a fresh machine can be slow (Electron unpacking, a cold disk). */
const LAUNCH = 90_000

export interface AppHandle {
  app: ElectronApplication
  page: Page
  dir: string
  close(): Promise<void>
}

/**
 * The Chromium switches Playwright gives an Electron it starts itself (playwright-core 1.63's
 * `chromiumSwitches`, which its loader script adds to the dev build). A packaged app is started as it
 * is and gets none, so they're passed here: without them a window that's covered or in the background,
 * as on CI desktops, is throttled and stops drawing, and screenshots and waits on a frame stall.
 * Windows' own occlusion tracking is turned off too, for the same reason.
 */
const PLAYWRIGHT_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion'
]
const PLAYWRIGHT_SWITCHES = [
  '--disable-field-trial-config',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-back-forward-cache',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-edgeupdater',
  '--disable-extensions',
  `--disable-features=${[...PLAYWRIGHT_DISABLED_FEATURES, 'CalculateNativeWinOcclusion'].join(',')}`,
  '--enable-features=CDPScreenshotNewSurface',
  '--allow-pre-commit-input',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-updater-scheduler',
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--no-first-run',
  '--password-store=basic',
  '--use-mock-keychain',
  '--no-service-autorun',
  '--export-tagged-pdf',
  '--disable-search-engine-choice-screen',
  '--unsafely-disable-devtools-self-xss-warnings',
  '--edge-skip-compat-layer-relaunch',
  '--disable-infobars',
  '--disable-sync'
]

/** A seed from a test's title (FNV-1a): each test gets a universe of its own, the same one every run. */
function seedOf(title: string): number {
  let hash = 0x811c9dc5
  for (const char of title) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193)
  return hash >>> 0
}

/**
 * Launches the app with a throwaway profile and update checks off (unless `env` turns them on).
 * Every random seed the app draws comes from the test's title, so a failure can be replayed.
 * UNIVERSE_E2E_EXECUTABLE tests a packaged build instead of the dev build.
 */
export async function launch(env: (dir: string) => Record<string, string> = () => ({})): Promise<AppHandle> {
  const dir = mkdtempSync(join(tmpdir(), 'universe-e2e-'))
  const executablePath = process.env.UNIVERSE_E2E_EXECUTABLE
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      ...(executablePath ? PLAYWRIGHT_SWITCHES : [join(__dirname, '..')]),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      // CI machines have no GPU; this allows WebGL on the software renderer.
      '--enable-unsafe-swiftshader'
    ],
    env: {
      ...process.env,
      UNIVERSE_USER_DATA: join(dir, 'user-data'),
      UNIVERSE_UPDATE_URL: 'off',
      // The local API on any free port, found through this test's own file: never a real Universe's.
      UNIVERSE_API_PORT: '0',
      UNIVERSE_API_DISCOVERY: join(dir, 'api.json'),
      // A stand-in for Tailscale, never the computer's own.
      UNIVERSE_TAILSCALE: join(__dirname, 'fake-tailscale.mjs'),
      FAKE_TAILSCALE_STATE: join(dir, 'tailscale.json'),
      UNIVERSE_E2E_SEED: String(seedOf(base.info().title)),
      ...env(dir)
    },
    timeout: LAUNCH
  })
  const page = await app.firstWindow({ timeout: LAUNCH })
  page.setDefaultTimeout(CI ? 60_000 : 30_000)
  // Wait for the app itself, not a fixed few seconds.
  await page.getByRole('button', { name: 'New Universe…' }).waitFor({ timeout: LAUNCH })
  return {
    app,
    page,
    dir,
    close: async () => {
      await app.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  }
}

/**
 * The e2e test: `h` is the app, launched for the test and closed after it. A failed test
 * gets a picture of the window as it was (test-results/<test>/failure.png).
 */
export const test = base.extend<{ h: AppHandle }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads which fixtures are used from this pattern
  h: async ({}, use, testInfo) => {
    const h = await launch()
    await use(h)
    if (testInfo.status !== testInfo.expectedStatus) {
      const path = testInfo.outputPath('failure.png')
      const taken = await h.page.screenshot({ path, timeout: 10_000 }).then(
        () => true,
        () => false
      )
      if (taken) await testInfo.attach('failure', { path, contentType: 'image/png' })
    }
    await h.close()
  }
})
export { expect }

/** Native file dialogs can't be driven by Playwright, so answer them from the main process. */
export async function stubSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, path)
}

export async function newProject({ app, page, dir }: AppHandle, name: string): Promise<string> {
  const path = join(dir, `${name}.universe`)
  await stubSaveDialog(app, path)
  await page.getByRole('button', { name: 'New Universe…' }).click()
  await expect(page.locator('.tree-row.selected')).toHaveText(new RegExp(name))
  return path
}

/**
 * A new project with a planet in it: a galaxy cluster, a galaxy, a star system, the planet and,
 * unless `surface` is false, its world surface ("<planet> Surface"), which ends up selected.
 */
export async function newWorld(h: AppHandle, project: string, { cluster = 'Virgo', planet = 'Terra', surface = true } = {}): Promise<void> {
  const { page } = h
  await newProject(h, project)
  await addChild(page, '+ Galaxy Cluster', cluster)
  await addChild(page, '+ Galaxy', 'Milky Way')
  await addChild(page, '+ Star System', 'Sol')
  await addChild(page, '+ Planet', planet)
  if (surface) await addChild(page, '+ World surface', `${planet} Surface`)
}

/** Part of the app's state, read from the main process. */
export const state = <K extends keyof AppState>(page: Page, key: K) =>
  page.evaluate(async (k) => (await window.universe.getState())[k], key) as Promise<AppState[K]>

/** A tree row whose name is exactly `name`. */
export const row = (page: Page, name: string) =>
  page.locator('.tree-row').filter({ has: page.locator('.tree-name').getByText(name, { exact: true }) })

export const inspector = (page: Page) => page.locator('.inspector')

/** Adds a child to the selected node via the inspector and renames it. */
export async function addChild(page: Page, button: string, name: string): Promise<void> {
  await inspector(page).getByRole('button', { name: button, exact: true }).click()
  const input = inspector(page).getByLabel('Name', { exact: true })
  await input.fill(name)
  await input.press('Enter')
  await expect(page.locator('.tree-row.selected')).toContainText(name)
}

/** Sets an inspector field by its label and commits it with Enter. */
export async function fill(page: Page, label: string, value: string): Promise<void> {
  const input = inspector(page).getByLabel(label, { exact: true })
  await input.fill(value)
  await input.press('Enter')
}

export const playhead = (page: Page) => page.getByRole('toolbar', { name: 'Timeline' }).getByLabel('Playhead')

/** Moves the timeline's playhead to `value` (a year, or a date in the world's calendar). */
export async function setPlayhead(page: Page, value: string): Promise<void> {
  await playhead(page).fill(value)
  await playhead(page).press('Enter')
}

/** Types into a rich-text notes editor and commits it by moving focus away. */
export async function writeNotes(page: Page, label: string, text: string): Promise<void> {
  const editor = page.getByRole('textbox', { name: label, exact: true })
  await editor.click()
  await page.keyboard.type(text)
  await page.locator('.panel-title').click()
}

/** Clicks an item of the real application menu, e.g. menu(app, 'Edit', 'Undo'). */
export async function menu(app: ElectronApplication, top: string, item: string): Promise<void> {
  await app.evaluate(({ Menu }, [t, i]) => {
    Menu.getApplicationMenu()!.items.find((m) => m.label === t)!.submenu!.items.find((m) => m.label === i)!.click()
  }, [top, item])
}

export const closeProject = (app: ElectronApplication) => menu(app, 'File', 'Close Project')

/** Waits for `count` frames of the page. */
export const frames = (page: Page, count = 2) =>
  page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((next) => requestAnimationFrame(next))
  }, count)

/**
 * Waits for the views to be drawn: nothing is generating terrain, no view says it isn't ready yet
 * (the globe, map and ground views mark themselves data-ready="false" until their first frame with
 * terrain), and two frames have passed.
 */
export async function viewReady(page: Page): Promise<void> {
  await expect(page.getByText('Generating terrain…')).toHaveCount(0, { timeout: SLOW })
  await expect(page.locator('[data-ready="false"]')).toHaveCount(0, { timeout: SLOW })
  await frames(page)
}

/** Switches the world to its flat map, once it's drawn. */
export async function openMap(page: Page): Promise<void> {
  await page.getByRole('button', { name: '🗺 Map' }).click()
  await expect(page.getByTestId('map')).toBeVisible()
  await viewReady(page)
}

/** Switches the world to its globe, once it's drawn. */
export async function openGlobe(page: Page): Promise<void> {
  await page.getByRole('button', { name: '🌐 Globe' }).click()
  await expect(page.getByTestId('globe')).toBeVisible()
  await viewReady(page)
}

const SHOTS = process.env.UNIVERSE_SHOTS === '1'

/**
 * A picture of the window for the build log (test-results/<name>.png), taken only when
 * UNIVERSE_SHOTS=1. It waits for the views to be drawn and for animations to finish, plus `wait` ms
 * for what nothing signals (a texture made in a worker, the camera easing to a stop). A picture
 * that can't be taken only warns: it isn't what the test checks.
 */
export async function shot(page: Page, name: string, { wait = 0 }: { wait?: number } = {}): Promise<void> {
  if (!SHOTS) return
  try {
    await viewReady(page)
    await page.evaluate(async () => {
      const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
      const ended = Promise.all(finite.map((a) => a.finished.catch(() => undefined)))
      await Promise.race([ended, new Promise((give) => setTimeout(give, 5000))])
    })
    if (wait) await page.waitForTimeout(wait)
    await page.screenshot({ path: `test-results/${name}.png`, timeout: SLOW })
  } catch (error) {
    console.warn(`No picture ${name}: ${(error as Error).message}`)
  }
}

export interface Point {
  x: number
  y: number
}
export type Box = Point & { width: number; height: number }
/** Fractions of a box's width and height, e.g. [0.5, 0.5] for its middle. */
export type Fraction = readonly [number, number]

const within = (box: Box, [fx, fy]: Fraction): Point => ({ x: box.x + box.width * fx, y: box.y + box.height * fy })
export const center = (box: Box): Point => within(box, [0.5, 0.5])

/** Clicks at a fraction of the element with this test id, measured at the click (tool options can move it). */
export async function clickAt(page: Page, testId: string, at: Fraction): Promise<void> {
  const { x, y } = within((await page.getByTestId(testId).boundingBox())!, at)
  await page.mouse.click(x, y)
}

/** Drags with the mouse from one point to another, through `steps` moves. */
export async function dragPoints(page: Page, from: Point, to: Point, { button = 'left', steps = 8 }: { button?: 'left' | 'right'; steps?: number } = {}): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down({ button })
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up({ button })
}

/** Drags across the element with this test id, between fractions of its box. */
export async function drag(page: Page, testId: string, from: Fraction, to: Fraction, button: 'left' | 'right' = 'left'): Promise<void> {
  const box = (await page.getByTestId(testId).boundingBox())!
  await dragPoints(page, within(box, from), within(box, to), { button })
}

const sameBox = (a: Box, b: Box) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height)) < 0.5

/** The box of something that glides into place, once it has stopped (two reads 100 ms apart agree). */
export async function settledBox(target: Locator): Promise<Box> {
  const read: { last: Box | null; box: Box | null } = { last: null, box: null }
  await expect
    .poll(
      async () => {
        read.last = read.box
        read.box = await target.boundingBox()
        return !!read.box && !!read.last && sameBox(read.box, read.last)
      },
      { intervals: [100] }
    )
    .toBe(true)
  return read.box!
}

/** Turns the mouse wheel `times` times over the middle of `target`. */
export async function wheel(page: Page, target: Locator, dy: number, times = 1): Promise<void> {
  const { x, y } = center((await target.boundingBox())!)
  await page.mouse.move(x, y)
  for (let i = 0; i < times; i++) await page.mouse.wheel(0, dy)
}

/** Draws a region on the map with four clicks and Enter. */
export async function drawRegion(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Draw region' }).click()
  for (const at of [[0.2, 0.3], [0.3, 0.28], [0.32, 0.4], [0.22, 0.42]] as const) await clickAt(page, 'map', at)
  await page.keyboard.press('Enter')
}
