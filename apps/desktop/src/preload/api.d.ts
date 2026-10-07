import type { BuildInfo, UniverseApi } from '../shared/api'

declare global {
  interface Window {
    universe: UniverseApi
  }
  const __BUILD_INFO__: BuildInfo
}

export {}
