import { NAMEABLE, type ContributionKind, type Nameable } from '@universe/plugins/manifest'
import { create } from 'zustand'
import type { PluginInfo, PluginRunRequest, PluginRunResult } from '../../shared/api'
import { selectNode, useUi } from './store'

/**
 * The plugins installed (PLAN.md §9, M16), and the one running: the plugin
 * manager, the world's inspector and right-click menus all run them from here.
 */

/** How the last run went, shown until it's dismissed. */
export type RunOutcome = { result: PluginRunResult } | { error: string }

type NameGenerator = NonNullable<PluginInfo['manifest']>['names'][number]

/** Names a name generator made, offered for one thing. */
export interface Naming {
  ref: { kind: Nameable; id: string }
  title: string
  names: string[]
}

interface PluginState {
  list: PluginInfo[]
  /** What's running (its title), while it does: one at a time. */
  running: string | null
  outcome: RunOutcome | null
  naming: Naming | null
  refresh(): Promise<void>
  set(list: PluginInfo[]): void
  run(request: PluginRunRequest, title: string): Promise<PluginRunResult | undefined>
  /** Runs a name generator for one thing and offers its names. */
  nameWith(ref: Naming['ref'], plugin: PluginInfo, namer: NameGenerator): Promise<void>
  dismiss(): void
  name(naming: Naming | null): void
}

export const usePlugins = create<PluginState>((set, get) => ({
  list: [],
  running: null,
  outcome: null,
  naming: null,
  refresh: async () => set({ list: await window.universe.plugins() }),
  set: (list) => set({ list }),
  run: async (request, title) => {
    if (get().running) return undefined
    set({ running: title, outcome: null })
    const reply = await window.universe.runPlugin(request)
    // Its log shows with it in the plugin manager.
    const list = reply.ok ? get().list.map((p) => (p.id === request.pluginId ? { ...p, log: reply.value.log } : p)) : get().list
    set({ running: null, outcome: reply.ok ? { result: reply.value } : { error: reply.error }, list })
    return reply.ok ? reply.value : undefined
  },
  nameWith: async (ref, plugin, namer) => {
    const world = selectNode(useUi.getState())
    const result = await get().run(
      { pluginId: plugin.id, kind: 'names', id: namer.id, worldId: world?.kind === 'world' ? world.id : undefined, options: {}, naming: { for: ref.kind, count: 8 } },
      namer.title
    )
    if (result?.names?.length) set({ outcome: null, naming: { ref, title: namer.title, names: result.names } })
  },
  dismiss: () => set({ outcome: null }),
  name: (naming) => set({ naming })
}))

/** A plugin's contributions of one kind, with the plugin, from those turned on and working. */
export function contributions<K extends ContributionKind>(list: PluginInfo[], kind: K) {
  return list.flatMap((plugin) => (plugin.enabled && !plugin.error && plugin.manifest ? plugin.manifest[kind].map((c) => ({ plugin, contribution: c as NonNullable<PluginInfo['manifest']>[K][number] })) : []))
}

/** Whether a kind of thing in a right-click menu is one a name generator can name. */
export const isNameable = (kind: string): kind is Nameable => (NAMEABLE as readonly string[]).includes(kind)
