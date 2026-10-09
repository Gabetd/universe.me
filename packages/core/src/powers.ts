import { z } from 'zod'
import { Id, Name, Notes, RecordMeta } from './schema'
import type { Era } from './timeline'
import { HexColor } from './world'

/**
 * Power systems (PLAN.md §4.6): how a world's powers work, age by age.
 * Magic, divine gifts, technology, politics or anything else: each system
 * answers a few questions (its aspects: Source, Rules, Costs & limits…) for
 * every age at once, and again for any of the world's eras where the answer
 * is different. An era is an age.
 */

export const POWER_TEMPLATES = ['magic', 'divine', 'psionic', 'technology', 'political', 'other'] as const
export const PowerTemplate = z.enum(POWER_TEMPLATES)
export type PowerTemplate = z.infer<typeof PowerTemplate>

/** One question a system answers. Its id stays when it's renamed, so its answers do too. */
export const PowerAspect = z.object({ id: z.string().min(1).max(60), label: Name })
export type PowerAspect = z.infer<typeof PowerAspect>

/** Answers, by aspect id. */
export const AspectValues = z.record(z.string().min(1).max(60), z.string().max(20_000))
export type AspectValues = z.infer<typeof AspectValues>

const Summary = z.string().max(2000)

export const PowerSystem = z.object({
  ...RecordMeta,
  name: Name,
  template: PowerTemplate,
  color: HexColor,
  /** What it is, in a line. */
  summary: Summary,
  aspects: z.array(PowerAspect).max(30),
  /** What's true in every age. */
  values: AspectValues,
  notes: Notes
})
export type PowerSystem = z.infer<typeof PowerSystem>

/** A system in one of its world's eras: what's different then, and how strong it is (0–1, or unsaid). */
export const PowerAge = z.object({
  ...RecordMeta,
  systemId: Id,
  eraId: Id,
  summary: Summary,
  strength: z.number().min(0).max(1).nullable(),
  values: AspectValues
})
export type PowerAge = z.infer<typeof PowerAge>

/** A system has at most one entry per era, so its id follows from both. */
export const powerAgeId = (systemId: string, eraId: string) => `powerAge:${systemId}:${eraId}`

/** Turns a label into an aspect id that isn't one of `taken`. */
export function aspectId(label: string, taken: Iterable<string> = []): string {
  const used = new Set(taken)
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'aspect'
  let id = base
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`
  return id
}

const aspects = (...labels: string[]): PowerAspect[] => labels.map((label) => ({ id: aspectId(label), label }))

/** What each template starts with: a name, a colour, the questions it answers, and what it's for. */
export const POWER_TEMPLATE_INFO: Record<PowerTemplate, { label: string; name: string; color: string; about: string; aspects: PowerAspect[] }> = {
  magic: {
    label: 'Magic',
    name: 'Magic',
    color: '#9b7bff',
    about: 'Spells, rituals, sorcery: power drawn from the world or beyond it.',
    aspects: aspects('Source', 'How it’s worked', 'Rules', 'Costs & limits', 'Who can use it', 'How it’s learned', 'Notable practitioners')
  },
  divine: {
    label: 'Divine',
    name: 'Divine powers',
    color: '#f2c14e',
    about: 'Gods, saints and spirits, and the gifts they give.',
    aspects: aspects('Gods & patrons', 'How favour is given', 'Miracles', 'Clergy & orders', 'Costs & taboos', 'Who is chosen')
  },
  psionic: {
    label: 'Psionic',
    name: 'Psionics',
    color: '#4fd1c5',
    about: 'Powers of the mind or body: telepathy, ki, inborn gifts.',
    aspects: aspects('Source', 'Abilities', 'Training', 'Costs & limits', 'Who has it', 'How others see it')
  },
  technology: {
    label: 'Technology & energy',
    name: 'Technology',
    color: '#5aa9ff',
    about: 'How the world is powered and what that makes possible.',
    aspects: aspects('Energy sources', 'Key technologies', 'Who controls it', 'What it makes possible', 'Costs & dangers', 'How it spreads')
  },
  political: {
    label: 'Political',
    name: 'Political power',
    color: '#ff7a8a',
    about: 'Who rules, and how they gain and keep it.',
    aspects: aspects('Who rules', 'How power is gained', 'How it’s kept', 'Institutions', 'Factions', 'Threats to it')
  },
  other: {
    label: 'Other',
    name: 'Power system',
    color: '#9aa7c7',
    about: 'Anything else: describe it your way.',
    aspects: aspects('Overview', 'Rules', 'Limits', 'Who uses it')
  }
}

/** A world's eras in time order (earliest start first; ties by end). */
export const erasInOrder = (eras: readonly Era[]) => [...eras].sort((a, b) => a.start - b.start || a.end - b.end)

/** The era in force at `t`: of those covering it, the one that started last. */
export function eraAt(eras: readonly Era[], t: number): Era | undefined {
  let found: Era | undefined
  for (const e of eras) if (e.start <= t && t <= e.end && (!found || e.start > found.start)) found = e
  return found
}

/** A system as it stands in one age: each aspect's answer (that age's, or the always-true one), and where each came from. */
export interface PowerInAge {
  era: Era | undefined
  age: PowerAge | undefined
  summary: string
  strength: number | null
  aspects: { id: string; label: string; value: string; fromAge: boolean }[]
}

/** `system` in `era` (or in no era: its always-true answers alone), given its age entries. */
export function powerIn(system: PowerSystem, ages: readonly PowerAge[], era: Era | undefined): PowerInAge {
  const age = era && ages.find((a) => a.systemId === system.id && a.eraId === era.id)
  return {
    era,
    age,
    summary: age?.summary || system.summary,
    strength: age?.strength ?? null,
    aspects: system.aspects.map(({ id, label }) => {
      const own = age?.values[id]?.trim()
      return { id, label, value: own || system.values[id] || '', fromAge: !!own }
    })
  }
}

/** `system` at a moment: in the era in force then. */
export const powerAt = (system: PowerSystem, ages: readonly PowerAge[], eras: readonly Era[], t: number) => powerIn(system, ages, eraAt(eras, t))
