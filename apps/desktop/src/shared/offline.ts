/**
 * Universe works entirely offline: projects are SQLite files on this computer
 * and nothing in them is ever sent anywhere. The main process enforces it by
 * cancelling every network request except the ones listed here.
 */

/** Local schemes the app is built from (its files are checked apart: see `isAppFile`). */
const LOCAL = ['data:', 'blob:', 'devtools:', 'chrome:', 'chrome-extension:']

/** Where the self-updater may download from (GitHub redirects release files to its CDN). */
export const UPDATE_HOSTS = ['https://github.com/Gabetd/universe.me/releases/download/', 'https://objects.githubusercontent.com/', 'https://release-assets.githubusercontent.com/']

/** The app's folder (a file URL ending in /) as `isAllowedRequest` compares paths: decoded, and in one case (Windows' drive letters and folders come in either). */
export const appFolder = (fileUrl: string) => decodeURIComponent(new URL(fileUrl).pathname).toLowerCase()

/**
 * Whether a file: URL is one of the app's own files: on this computer (a
 * file://host/ address is another computer's, which on Windows is a network
 * share) and, given `files` (the app's folder, from `appFolder`), inside it.
 */
function isAppFile(url: string, files?: string): boolean {
  let path: string
  try {
    const u = new URL(url)
    if (u.host) return false
    path = decodeURIComponent(u.pathname)
  } catch {
    return false
  }
  if (path.includes('/../') || path.includes('\\')) return false
  return !files || path.toLowerCase().startsWith(files)
}

/**
 * Whether a request may go out. Pages (`fromPage`) only load the app itself
 * (`files`: its folder, from `appFolder`); the main process may also reach the update hosts.
 * `extra` adds origins for development (the Vite dev server) and tests (a
 * local update server).
 */
export function isAllowedRequest(url: string, fromPage: boolean, extra: string[] = [], files?: string): boolean {
  if (url.startsWith('file:')) return isAppFile(url, files)
  if (LOCAL.some((scheme) => url.startsWith(scheme))) return true
  if (extra.some((prefix) => url.startsWith(prefix))) return true
  return !fromPage && UPDATE_HOSTS.some((prefix) => url.startsWith(prefix))
}
