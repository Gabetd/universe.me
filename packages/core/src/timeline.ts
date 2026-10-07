import { z } from 'zod'
import { Id, RecordMeta } from './schema'
import { Precision, Time } from './time'
import { HexColor, LatLon } from './world'

/**
 * Timeline records (PLAN.md §4.4). Every node can have a timeline; its records
 * point to it with `ownerId`. In the UI a world's timeline is the one shown
 * for the world and for the body it covers.
 */
export const EventLocation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('point'), ...LatLon.shape }),
  z.object({ kind: z.literal('region'), regionId: Id })
])
export type EventLocation = z.infer<typeof EventLocation>

export const TimelineEvent = z.object({
  ...RecordMeta,
  title: z.string().min(1).max(200),
  start: Time,
  /** Null for an instant (a moment rather than a span). */
  end: Time.nullable(),
  precision: Precision,
  /** Null puts the event in the default lane. */
  laneId: Id.nullable(),
  groupId: Id.nullable(),
  color: HexColor,
  notes: z.string(),
  tags: z.array(z.string()),
  /** Where it happens: points or regions on the owning world. */
  locations: z.array(EventLocation),
  /** Where its card sits on the world's canvas; unset or null lays it out automatically. */
  canvas: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
  /** Every event gets a card on the canvas unless hidden. Older events don't have these fields. */
  canvasHidden: z.boolean().nullable().optional()
})
export type TimelineEvent = z.infer<typeof TimelineEvent>

export const LINK_TYPES = ['causes', 'enables', 'prevents', 'precedes', 'related'] as const
export const LinkType = z.enum(LINK_TYPES)
export type LinkType = z.infer<typeof LinkType>

/** Link types that say the `from` event comes first. */
export const ORDERED_LINKS: readonly LinkType[] = ['causes', 'enables', 'precedes']

export const EventLink = z.object({
  ...RecordMeta,
  fromId: Id,
  toId: Id,
  type: LinkType,
  note: z.string()
})
export type EventLink = z.infer<typeof EventLink>

/** Several events merged into one ("The Great War"). Its span is its events' span. */
export const EventGroup = z.object({
  ...RecordMeta,
  title: z.string().min(1).max(200),
  color: HexColor,
  notes: z.string(),
  collapsed: z.boolean()
})
export type EventGroup = z.infer<typeof EventGroup>

/** A named background span ("Age of Ice"). */
export const Era = z.object({
  ...RecordMeta,
  name: z.string().min(1).max(200),
  start: Time,
  end: Time,
  color: HexColor,
  notes: z.string()
})
export type Era = z.infer<typeof Era>

export const Lane = z.object({
  ...RecordMeta,
  name: z.string().min(1).max(100),
  /** Lanes are shown in ascending order. */
  order: z.number()
})
export type Lane = z.infer<typeof Lane>

/** What an EntityChange can change about a region. Reshaping over time comes later. */
export const RegionChangePatch = z.object({ name: z.string().min(1).max(200).optional(), color: HexColor.optional() })
export type RegionChangePatch = z.infer<typeof RegionChangePatch>

/**
 * A time-bound change to something on the world: a region appears (is
 * founded), vanishes, or is renamed/recolored at `at`. Optional `causeEventId`
 * answers "why does it look like this?". Structures change through event
 * effects and maintenance changes instead (structures.ts).
 */
export const EntityChange = z.object({
  ...RecordMeta,
  entityKind: z.enum(['region']),
  entityId: Id,
  at: Time,
  change: z.enum(['appear', 'vanish', 'update']),
  patch: RegionChangePatch,
  causeEventId: Id.nullable(),
  note: z.string()
})
export type EntityChange = z.infer<typeof EntityChange>

/** Per-timeline settings. Its id is the owner's id. */
export const TimelineSettings = z.object({
  ...RecordMeta,
  /** The story's present, drawn as the "Now" marker. */
  now: Time
})
export type TimelineSettings = z.infer<typeof TimelineSettings>
