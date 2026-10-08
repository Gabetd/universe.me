import { z } from 'zod'
import { Id, RecordMeta } from './schema'
import { Time } from './time'
import { HexColor } from './world'

/**
 * Structures (PLAN.md §4.7): buildings placed on a world from blueprints,
 * whose condition over time follows from when they were built, whether they
 * are maintained, and what events did to them (condition.ts).
 */

export const MATERIALS = ['cloth', 'thatch', 'mud', 'wood', 'glass', 'iron', 'steel', 'concrete', 'brick', 'stone', 'earth', 'megalith', 'magic'] as const
export const Material = z.enum(MATERIALS)
export type Material = z.infer<typeof Material>

/**
 * What the weather does to a structure where it stands (PLAN.md §4.7), each
 * 0–1: how wet it is, how often it freezes and thaws, how hot, how much salt
 * the sea air carries, and how fast plants grow over things.
 */
export interface Exposure {
  moisture: number
  freezeThaw: number
  heat: number
  salt: number
  growth: number
}

/** A temperate, inland climate: the half-lives below are for this. */
const TEMPERATE_EXPOSURE: Exposure = { moisture: 0.5, freezeThaw: 0.4, heat: 0.15, salt: 0.05, growth: 0.6 }

/**
 * How long each material lasts when nobody looks after it: the half-life of
 * its condition, in years, in a temperate climate and before the world's
 * erosion speed. Plausible rather than exact: a wooden cabin is a ruin in
 * about 150 years, a stone castle in a few thousand, a pyramid in tens of
 * thousands. Magic never decays. `weather` is how much each kind of exposure
 * wears it: wood rots in the wet, iron rusts by the sea, stone splits in
 * frost.
 */
export const MATERIAL_INFO: Record<Material, { label: string; halfLifeYears: number; color: string; weather: Partial<Exposure> }> = {
  cloth: { label: 'Cloth', halfLifeYears: 6, color: '#d8cdb4', weather: { moisture: 0.6, heat: 0.4, growth: 0.2 } },
  thatch: { label: 'Thatch', halfLifeYears: 25, color: '#c9a95c', weather: { moisture: 0.7, growth: 0.5, heat: 0.2 } },
  mud: { label: 'Mud brick', halfLifeYears: 45, color: '#a88a62', weather: { moisture: 1, freezeThaw: 0.4 } },
  wood: { label: 'Wood', halfLifeYears: 65, color: '#8b5a2b', weather: { moisture: 0.7, growth: 0.5, freezeThaw: 0.2 } },
  glass: { label: 'Glass', halfLifeYears: 150, color: '#9fd3e6', weather: { freezeThaw: 0.2, heat: 0.1 } },
  iron: { label: 'Iron', halfLifeYears: 250, color: '#5d5f66', weather: { moisture: 0.8, salt: 1 } },
  steel: { label: 'Steel', halfLifeYears: 300, color: '#9aa3ad', weather: { moisture: 0.5, salt: 0.8 } },
  concrete: { label: 'Concrete', halfLifeYears: 600, color: '#b5b1a8', weather: { freezeThaw: 0.7, salt: 0.5, moisture: 0.2 } },
  brick: { label: 'Brick', halfLifeYears: 900, color: '#a5523a', weather: { freezeThaw: 0.7, moisture: 0.3, growth: 0.2 } },
  stone: { label: 'Stone', halfLifeYears: 1500, color: '#a39e93', weather: { freezeThaw: 0.6, growth: 0.3, moisture: 0.2, salt: 0.2 } },
  earth: { label: 'Earthworks', halfLifeYears: 3000, color: '#7d6b4f', weather: { moisture: 0.5, growth: 0.4 } },
  megalith: { label: 'Megalith', halfLifeYears: 10000, color: '#d8c9a3', weather: { freezeThaw: 0.3, moisture: 0.1 } },
  magic: { label: 'Magic', halfLifeYears: Infinity, color: '#b48cff', weather: {} }
}

/**
 * How much faster a material wears where it stands than in a temperate
 * climate: 1 there, more where its weaknesses are (wood in a rainforest,
 * iron by the sea), less where they aren't (wood in a desert).
 */
export function weatherFactor(material: Material, exposure: Exposure | undefined): number {
  if (!exposure) return 1
  const w = MATERIAL_INFO[material].weather
  const sum = (e: Exposure) => (Object.keys(w) as (keyof Exposure)[]).reduce((n, k) => n + w[k]! * e[k], 0)
  const factor = (0.5 + sum(exposure)) / (0.5 + sum(TEMPERATE_EXPOSURE))
  return Math.min(4, Math.max(0.2, factor))
}

/** `wedge` is a gable roof: a triangular prism whose ridge runs along its depth (z). */
export const SHAPES = ['box', 'cylinder', 'cone', 'pyramid', 'sphere', 'wedge'] as const
export const Shape = z.enum(SHAPES)
export type Shape = z.infer<typeof Shape>

const Vec3 = z.tuple([z.number(), z.number(), z.number()])

/** One primitive of a blueprint, in metres. `at` is the centre of its base; y is up. */
export const BlueprintPart = z.object({
  shape: Shape,
  material: Material,
  color: HexColor,
  size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
  at: Vec3,
  /** Degrees around the vertical axis. */
  rotation: z.number()
})
export type BlueprintPart = z.infer<typeof BlueprintPart>

/** An imported glTF model, stored in the project file. It decays as one material. */
export const BlueprintModel = z.object({ assetId: Id, material: Material, heightM: z.number().positive() })
export type BlueprintModel = z.infer<typeof BlueprintModel>

/** A reusable structure template. The project's library is owned by its root node. */
export const Blueprint = z.object({
  ...RecordMeta,
  name: z.string().min(1).max(200),
  parts: z.array(BlueprintPart),
  model: BlueprintModel.nullable(),
  /** Whether new structures from it start out maintained (a castle) or weathering (a standing stone). */
  maintainedByDefault: z.boolean(),
  tags: z.array(z.string())
})
export type Blueprint = z.infer<typeof Blueprint>

/** A structure on a world. Its condition at any time is derived (condition.ts), never stored. */
export const Structure = z.object({
  ...RecordMeta,
  name: z.string().min(1).max(200),
  blueprintId: Id,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Degrees around the vertical. */
  rotation: z.number(),
  scale: z.number().positive(),
  /** When it was built; a `build` effect can make it earlier (or rebuild it later). */
  builtAt: Time,
  /** Maintained from the start? Maintenance changes flip it later on. */
  maintained: z.boolean(),
  /** Keeps it from weathering at all (monuments, magic). */
  neverDecays: z.boolean(),
  /** Show its name in the viewport. */
  label: z.boolean(),
  notes: z.string(),
  tags: z.array(z.string())
})
export type Structure = z.infer<typeof Structure>

/** "From `at` on, this structure is (not) maintained." */
export const MaintenanceChange = z.object({
  ...RecordMeta,
  structureId: Id,
  at: Time,
  maintained: z.boolean(),
  causeEventId: Id.nullable()
})
export type MaintenanceChange = z.infer<typeof MaintenanceChange>

export const EFFECT_TYPES = ['build', 'damage', 'destroy', 'repair', 'set_maintenance', 'modify'] as const
export const EffectType = z.enum(EFFECT_TYPES)
export type EffectType = z.infer<typeof EffectType>

/** Which structures an effect reaches: some by name, all in a region, or all within a radius of the event. */
export const EffectTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('structures'), ids: z.array(Id) }),
  z.object({ kind: z.literal('region'), regionId: Id }),
  /** Around the event's place. With `falloff`, the effect weakens linearly to nothing at the edge. */
  z.object({ kind: z.literal('radius'), km: z.number().positive(), falloff: z.boolean() })
])
export type EffectTarget = z.infer<typeof EffectTarget>

/** Narrows a target: only structures with one of these tags, or with a part of one of these materials. Empty lists don't filter. */
export const EffectFilter = z.object({ tags: z.array(z.string()), materials: z.array(Material) })
export type EffectFilter = z.infer<typeof EffectFilter>

/** What an event does to structures, at the event's start (PLAN.md §4.7). */
export const EventEffect = z.object({
  ...RecordMeta,
  eventId: Id,
  type: EffectType,
  target: EffectTarget,
  filter: EffectFilter,
  /** damage and repair: condition points (0–100). */
  amount: z.number().min(0).max(100),
  /** set_maintenance. */
  maintained: z.boolean(),
  /** modify: a new name, and/or a new blueprint (an expansion, a conversion). */
  rename: z.string().min(1).max(200).nullable(),
  blueprintId: Id.nullable()
})
export type EventEffect = z.infer<typeof EventEffect>

/** Condition stages and where each begins (PLAN.md §4.7). */
export const STAGES = [
  { stage: 'pristine', label: 'Pristine', from: 90 },
  { stage: 'worn', label: 'Worn', from: 70 },
  { stage: 'weathered', label: 'Weathered', from: 45 },
  { stage: 'damaged', label: 'Damaged', from: 20 },
  { stage: 'ruin', label: 'Ruin', from: 5 },
  { stage: 'remnant', label: 'Remnant', from: 0 }
] as const
export type Stage = (typeof STAGES)[number]['stage'] | 'destroyed'

export function stageOf(condition: number): Stage {
  if (condition <= 0) return 'destroyed'
  return STAGES.find((s) => condition >= s.from)?.stage ?? 'remnant'
}
