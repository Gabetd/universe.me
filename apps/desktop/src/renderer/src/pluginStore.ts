import type { ContributionKind, Nameable } from '@universe/plugins/manifest'
import { create } from 'zustand'
import type { PluginInfo, PluginRunRequest, PluginRunResult } from '../../shared/api'
import type { ElementRef } from './contextMenu'

/**
 * The plugins installed (PLAN.md §9, M16), and the one running: the plugin
 * manager, the world's inspector and right-click menus all run them from here.
 */

/** How the last run went, shown until it's dismissed. */
export interface RunNote {
  title: string
  result?: PluginRunResult
  error?: string
}

/** Names a name generator made, offered for one thing. */
export interface Naming {
  ref: ElementRef
  title: string
  names: string[]
}

interface PluginState {
  list: PluginInfo[]
  /** What's running (its title), while it does: one at a time. */
  running: string | null
  note: RunNote | null
  naming: Naming | null
  refresh(): Promise<void>
  set(list: PluginInfo[]): void
  run(request: PluginRunRequest, title: string): Promise<PluginRunResult | undefined>
  dismiss(): void
  name(naming: Naming | null): void
}

export const usePlugins = create<PluginState>((set, get) => ({
  list: [],
  running: null,
  note: null,
  naming: null,
  refresh: async () => set({ list: await window.universe.plugins() }),
  set: (list) => set({ list }),
  run: async (request, title) => {
    if (get().running) return undefined
    set({ running: title, note: null })
    const reply = await window.universe.runPlugin(request)
    // Its log is in the list now.
    set({ running: null, note: reply.ok ? { title, result: reply.value } : { title, error: reply.error }, list: await window.universe.plugins() })
    return reply.ok ? reply.value : undefined
  },
  dismiss: () => set({ note: null }),
  name: (naming) => set({ naming })
}))

/** A plugin's contributions of one kind, with the plugin, from those turned on and working. */
export function contributions<K extends ContributionKind>(list: PluginInfo[], kind: K) {
  return list.flatMap((plugin) => (plugin.enabled && !plugin.error && plugin.manifest ? plugin.manifest[kind].map((c) => ({ plugin, contribution: c as NonNullable<PluginInfo['manifest']>[K][number] })) : []))
}

/** What each kind of thing in a right-click menu is to a name generator. */
export const NAMEABLE_KINDS: Partial<Record<ElementRef['kind'], Nameable>> = {
  node: 'node',
  region: 'region',
  structure: 'structure',
  character: 'character',
  faction: 'faction',
  species: 'species',
  event: 'event'
}
