import type { z } from 'zod'
import { Orbit, Star } from './astro'
import { Character } from './characters'
import { EcoLink, Species } from './ecosystem'
import { Blueprint, EventEffect, MaintenanceChange, Structure } from './structures'
import { Faction, Holding, Membership, Relationship } from './factions'
import { Finding } from './findings'
import { PowerAge, PowerSystem } from './powers'
import { Theme, ThemeSpan } from './themes'
import { EntityChange, Era, EventGroup, EventLink, Lane, TimelineEvent, TimelineSettings } from './timeline'

/**
 * Every kind of record kept in the generic `records` table: the timeline
 * (timeline.ts), structures (structures.ts), characters (characters.ts), stars and orbits (astro.ts), species (ecosystem.ts), themes (themes.ts), power systems (powers.ts), findings (findings.ts) and factions and relationships (factions.ts). Each record belongs to a node
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
  effect: EventEffect,
  character: Character,
  star: Star,
  orbit: Orbit,
  lifeform: Species,
  ecolink: EcoLink,
  theme: Theme,
  themeSpan: ThemeSpan,
  power: PowerSystem,
  powerAge: PowerAge,
  finding: Finding,
  faction: Faction,
  membership: Membership,
  holding: Holding,
  relationship: Relationship
} as const
export type RecordKind = keyof typeof RECORD_SCHEMAS
export const RECORD_KINDS = Object.keys(RECORD_SCHEMAS) as RecordKind[]
export type RecordOf<K extends RecordKind> = z.infer<(typeof RECORD_SCHEMAS)[K]>

/** All of a project's live records, by kind, as sent to the UI. */
export type TimelineData = { [K in RecordKind as `${K}s`]: RecordOf<K>[] }

export const EMPTY_TIMELINE = Object.fromEntries(RECORD_KINDS.map((k) => [`${k}s`, []])) as unknown as TimelineData
