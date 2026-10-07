/**
 * Universe works entirely offline: projects are SQLite files on this computer
 * and nothing in them is ever sent anywhere. The main process enforces it by
 * cancelling every network request except the ones listed here.
 */

/** Local schemes the app is built from. */
const LOCAL = ['file:', 'data:', 'blob:', 'devtools:', 'chrome:', 'chrome-extension:']

/** Where the self-updater may download from (GitHub redirects release files to its CDN). */
export const UPDATE_HOSTS = ['https://github.com/Gabetd/universe.me/releases/download/', 'https://objects.githubusercontent.com/', 'https://release-assets.githubusercontent.com/']

/**
 * Whether a request may go out. Pages (`fromPage`) only load the app itself;
 * the main process may also reach the update hosts. `extra` adds origins for
 * development (the Vite dev server) and tests (a local update server).
 */
export function isAllowedRequest(url: string, fromPage: boolean, extra: string[] = []): boolean {
  if (LOCAL.some((scheme) => url.startsWith(scheme))) return true
  if (extra.some((prefix) => url.startsWith(prefix))) return true
  return !fromPage && UPDATE_HOSTS.some((prefix) => url.startsWith(prefix))
}
