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
 * How long each material lasts when nobody looks after it: the half-life of
 * its condition, in years, before the world's erosion speed. Plausible rather
 * than exact: a wooden cabin is a ruin in about 150 years, a stone castle in a
 * few thousand, a pyramid in tens of thousands. Magic never decays.
 */
export const MATERIAL_INFO: Record<Material, { label: string; halfLifeYears: number; color: string }> = {
  cloth: { label: 'Cloth', halfLifeYears: 6, color: '#d8cdb4' },
  thatch: { label: 'Thatch', halfLifeYears: 25, color: '#c9a95c' },
  mud: { label: 'Mud brick', halfLifeYears: 45, color: '#a88a62' },
  wood: { label: 'Wood', halfLifeYears: 65, color: '#8b5a2b' },
  glass: { label: 'Glass', halfLifeYears: 150, color: '#9fd3e6' },
  iron: { label: 'Iron', halfLifeYears: 250, color: '#5d5f66' },
  steel: { label: 'Steel', halfLifeYears: 300, color: '#9aa3ad' },
  concrete: { label: 'Concrete', halfLifeYears: 600, color: '#b5b1a8' },
  brick: { label: 'Brick', halfLifeYears: 900, color: '#a5523a' },
  stone: { label: 'Stone', halfLifeYears: 1500, color: '#a39e93' },
  earth: { label: 'Earthworks', halfLifeYears: 3000, color: '#7d6b4f' },
  megalith: { label: 'Megalith', halfLifeYears: 10000, color: '#d8c9a3' },
  magic: { label: 'Magic', halfLifeYears: Infinity, color: '#b48cff' }
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
