import { z } from 'zod'

/**
 * A plugin (PLAN.md §9, M16) is a folder: `plugin.json` (this manifest) and
 * its code (`main.js`, an ES module, and any modules it imports from the
 * folder). It contributes generators (run on a world or the universe, adding
 * to it through the same operations as the API), exporters (a world or the
 * universe out to files the user saves) and name generators (names to give
 * things). Each can ask for options, shown as a form before it runs.
 */

const Id = z
  .string()
  .regex(/^[A-Za-z][\w-]{0,59}$/, 'Ids are letters, digits, - and _, starting with a letter')
  .describe('How the code knows it: the name of its function')
const Label = z.string().trim().min(1).max(120)
const Description = z.string().trim().max(1000).optional()

const OptionBase = { id: Id, label: Label, description: Description }

/** Something a contribution asks for before it runs, shown as a field. */
export const PluginOption = z.discriminatedUnion('type', [
  z.object({ ...OptionBase, type: z.literal('text'), default: z.string().max(10_000).default('') }),
  z.object({ ...OptionBase, type: z.literal('number'), default: z.number().default(0), min: z.number().optional(), max: z.number().optional(), step: z.number().positive().optional() }),
  z.object({ ...OptionBase, type: z.literal('choice'), choices: z.array(Label).min(1).max(100), default: Label.optional() }),
  z.object({ ...OptionBase, type: z.literal('flag'), default: z.boolean().default(false) })
])
export type PluginOption = z.infer<typeof PluginOption>

/** What a generator or exporter works on: a world surface, or the whole universe. */
export const PLUGIN_TARGETS = ['world', 'universe'] as const
export const PluginTarget = z.enum(PLUGIN_TARGETS)
export type PluginTarget = z.infer<typeof PluginTarget>

/** The things a name generator can name (in their right-click menus). */
export const NAMEABLE = ['character', 'faction', 'region', 'structure', 'node', 'species', 'event'] as const
export const Nameable = z.enum(NAMEABLE)
export type Nameable = z.infer<typeof Nameable>

const Contribution = { id: Id, title: Label, description: Description, options: z.array(PluginOption).max(40).default([]) }

export const PluginManifest = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,59}$/, 'A plugin id is lowercase letters, digits and -')
    .describe('Unique among the plugins installed'),
  name: Label,
  version: z.string().trim().min(1).max(40),
  description: Description,
  author: z.string().trim().max(120).optional(),
  /** Its code, relative to the folder. */
  main: z
    .string()
    .regex(/^(?!.*\.\.)[\w-][\w./-]*\.m?js$/, 'main is a .js file in the plugin’s folder')
    .default('main.js'),
  generators: z.array(z.object({ ...Contribution, on: PluginTarget.default('world') })).max(100).default([]),
  exporters: z.array(z.object({ ...Contribution, on: PluginTarget.default('world') })).max(100).default([]),
  names: z.array(z.object({ ...Contribution, for: z.array(Nameable).min(1) })).max(100).default([])
})
export type PluginManifest = z.infer<typeof PluginManifest>

/** The kinds of contribution, as the code exports them (`export const generators = { … }`). */
export const CONTRIBUTION_KINDS = ['generators', 'exporters', 'names'] as const
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number]

/** A manifest read from text, or why it can't be. */
export function readManifest(text: string): { manifest: PluginManifest } | { error: string } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    return { error: `plugin.json isn’t JSON: ${(err as Error).message}` }
  }
  const parsed = PluginManifest.safeParse(json)
  if (!parsed.success) return { error: `plugin.json: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'it'}: ${i.message}`).join('; ')}` }
  const m = parsed.data
  for (const kind of CONTRIBUTION_KINDS) {
    const ids = m[kind].map((c) => c.id)
    const twice = ids.find((id, i) => ids.indexOf(id) !== i)
    if (twice) return { error: `plugin.json: two ${kind} are called ${twice}` }
  }
  return { manifest: m }
}

/** A contribution's options as they start: each one's default. */
export const defaultOptions = (options: readonly PluginOption[]): Record<string, unknown> =>
  Object.fromEntries(options.map((o) => [o.id, o.type === 'choice' ? (o.default ?? o.choices[0]) : o.default]))
