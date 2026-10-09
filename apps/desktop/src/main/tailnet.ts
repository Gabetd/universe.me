/** The port Universe answers on in the tailnet, through `tailscale serve` (PLAN.md §6.6). */
export const APP_HTTPS_PORT = 8443

/** For tests: where each stand-in device answers, by tailnet name, in place of its HTTPS address. Read once. */
export const TAILNET_URLS: Record<string, string> = process.env.UNIVERSE_TAILNET_URLS ? (JSON.parse(process.env.UNIVERSE_TAILNET_URLS) as Record<string, string>) : {}

/** Where a device's Universe answers: its tailnet name's HTTPS on Universe's port. */
export const tailnetBase = (host: string) => TAILNET_URLS[host] ?? `https://${host}:${APP_HTTPS_PORT}`
