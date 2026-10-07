import type { z } from 'zod'
import { Blueprint, EventEffect, MaintenanceChange, Structure } from './structures'
import { EntityChange, Era, EventGroup, EventLink, Lane, TimelineEvent, TimelineSettings } from './timeline'

/**
 * Every kind of record kept in the generic `records` table: the timeline
 * (timeline.ts) and structures (structures.ts). Each record belongs to a node
 * through `ownerId`, mostly a world.
 */
export const RECORD_SCHEMAS = {
  event: TimelineEvent,
  link: EventLink,
  group: EventGroup,
  era: Era,
  lane: Lane,
  change: EntityChange,
  timeline: TimelineSettings,
  blueprint: Blueprint,
  structure: Structure,
  maintenance: MaintenanceChange,
  effect: EventEffect
} as const
export type RecordKind = keyof typeof RECORD_SCHEMAS
export const RECORD_KINDS = Object.keys(RECORD_SCHEMAS) as RecordKind[]
export type RecordOf<K extends RecordKind> = z.infer<(typeof RECORD_SCHEMAS)[K]>

/** All of a project's live records, by kind, as sent to the UI. */
export type TimelineData = { [K in RecordKind as `${K}s`]: RecordOf<K>[] }

export const EMPTY_TIMELINE = Object.fromEntries(RECORD_KINDS.map((k) => [`${k}s`, []])) as unknown as TimelineData
