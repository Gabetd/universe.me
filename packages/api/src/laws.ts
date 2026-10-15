import { LAW_KINDS, LAW_KIND_LABELS, lawInForce, lawOwner, lawSpan, scopeId, stripUndefined, type Law, type LawPatch } from '@universe/core'
import { z } from 'zod'
import { spanText } from './describe'
import { ApiError, findOr404 } from './host'
import type { WorldView } from './model'
import { When, operation, type ApiContext } from './operation'
import { htmlToText, textToHtml } from './text'
import { factionNamed, newId, notesAndTags, spanOf, write } from './writes'

/** Laws of eras and factions (core laws.ts) for AI clients: what's law where and when, and making, changing and repealing laws, as the era panel and the faction page do in the app. */

function eraNamed(view: WorldView, nameOrId: string) {
  const all = view.timeline.eras
  const e = all.find((x) => x.id === nameOrId) ?? all.find((x) => x.name.toLowerCase() === nameOrId.trim().toLowerCase())
  if (!e) throw new ApiError(404, `There is no era ${nameOrId} on ${view.node.name}${all.length ? ` (its eras: ${all.map((x) => x.name).join(', ')})` : ''}`)
  return e
}

/** Whose a law is, in words: "the era The Long Winter", "the faction The Kingdom of Varn". */
const whose = (view: WorldView, law: Law) => `the ${law.scope.kind} ${lawOwner(law, view.timeline)?.name ?? '(deleted)'}`

/** A law as a client reads it: whose, what, and when it holds (within its era's or faction's time). */
export function describeLaw(ctx: ApiContext, view: WorldView, law: Law, t?: number) {
  const timeline = view.timeline
  return {
    id: law.id,
    name: law.name,
    of: whose(view, law),
    kind: LAW_KIND_LABELS[law.kind],
    ...(law.summary && { says: law.summary }),
    ...(law.penalty && { penalty: law.penalty }),
    inForce: spanText(ctx.models, law.ownerId, lawSpan(law, timeline)),
    ...(t !== undefined && { inForceThen: lawInForce(law, t, timeline) }),
    ...(law.startEventId && { enactedBy: timeline.events.find((e) => e.id === law.startEventId)?.title }),
    ...(law.endEventId && { repealedBy: timeline.events.find((e) => e.id === law.endEventId)?.title }),
    ...(law.notes && { notes: htmlToText(law.notes) }),
    ...(law.tags.length && { tags: law.tags })
  }
}

const Says = { says: z.string().max(2000).optional().describe('What it says, in a line'), penalty: z.string().max(500).optional().describe('What breaking it costs') }
const Kind = z.enum(LAW_KINDS).describe(`What it’s about: ${LAW_KINDS.join(', ')}`)

export const LAW_OPERATIONS = [
  operation({
    name: 'list_laws',
    title: 'List a world’s laws',
    description:
      'The laws of a world’s eras and factions: each one’s id, name, whose it is, kind, what it says, its penalty, when it’s in force (within its era’s or faction’s time) and the events that enacted and repealed it. With `at`, whether each is in force then; with `of`, only one era’s or faction’s (by name or id).',
    input: z.object({ worldId: z.string(), at: When.optional(), of: z.string().optional().describe('An era or a faction, by name or id') }),
    route: { method: 'GET', path: '/worlds/:worldId/laws' },
    run: (ctx, { worldId, at, of }) => {
      const view = ctx.models.world(worldId)
      const t = at === undefined ? undefined : ctx.models.when(worldId, at)
      let laws = view.timeline.laws
      if (of) {
        const era = view.timeline.eras.find((e) => e.id === of || e.name.toLowerCase() === of.trim().toLowerCase())
        const id = era?.id ?? factionNamed(view, of).id
        laws = laws.filter((l) => scopeId(l.scope) === id)
      }
      return { ...(t !== undefined && { date: ctx.models.date(worldId, t) }), laws: laws.map((l) => describeLaw(ctx, view, l, t)) }
    }
  }),
  operation({
    name: 'add_law',
    title: 'Make a law',
    description:
      'Gives an era (everyone on the world, while it lasts) or a faction (its members, and the factions part of it) a law: its name, kind, what it says and what breaking it costs, enacted and repealed when or by which events (left out: from when the era or faction begins, until it ends). Name exactly one of `era` and `faction`. Returns its id.',
    input: z.object({
      worldId: z.string(),
      era: z.string().optional().describe('The era whose law it is, by name or id'),
      faction: z.string().optional().describe('The faction whose law it is, by name or id'),
      name: z.string().min(1).max(200),
      kind: Kind.optional(),
      ...Says,
      enacted: When.optional(),
      repealed: When.optional(),
      enactedBy: z.string().optional().describe('The event that enacted it (its date is used if `enacted` isn’t given)'),
      repealedBy: z.string().optional().describe('The event that repealed it'),
      notes: z.string().max(500_000).optional(),
      tags: z.array(z.string().min(1).max(60)).optional()
    }),
    route: { method: 'POST', path: '/worlds/:worldId/laws' },
    write: true,
    run: (ctx, p) => {
      const view = ctx.models.world(p.worldId)
      if (!p.era === !p.faction) throw new ApiError(400, 'Name the era or the faction whose law it is (one of them)')
      const scope = p.era ? { kind: 'era' as const, eraId: eraNamed(view, p.era).id } : { kind: 'faction' as const, factionId: factionNamed(view, p.faction!).id }
      const span = spanOf(ctx, p.worldId, { from: p.enacted, until: p.repealed, fromEventId: p.enactedBy, untilEventId: p.repealedBy })
      const id = newId()
      const payload = { id, scope, name: p.name, ...span, ...stripUndefined({ kind: p.kind, summary: p.says, penalty: p.penalty }), ...notesAndTags(p) }
      return write(ctx, [{ type: 'law.create', payload }], `Made the law ${p.name}`, { lawId: id })
    }
  }),
  operation({
    name: 'update_law',
    title: 'Change or repeal a law',
    description:
      'Changes a law (by its id from list_laws): its name, kind, what it says, its penalty, when it was enacted or repealed (null: from when its era or faction begins, or until it ends) and the events that did it (null: none). Repeal one by giving it `repealed` (or `repealedBy`). Notes replace what’s there.',
    input: z.object({
      lawId: z.string(),
      name: z.string().min(1).max(200).optional(),
      kind: Kind.optional(),
      ...Says,
      enacted: z.union([When, z.null()]).optional(),
      repealed: z.union([When, z.null()]).optional(),
      enactedBy: z.union([z.string(), z.null()]).optional(),
      repealedBy: z.union([z.string(), z.null()]).optional(),
      notes: z.string().max(500_000).optional(),
      tags: z.array(z.string().min(1).max(60)).optional()
    }),
    route: { method: 'POST', path: '/laws/:lawId' },
    write: true,
    run: (ctx, p) => {
      const m = ctx.models
      const law = findOr404(m.data().timeline.laws, p.lawId, 'law')
      const date = (w: string | number | null) => (w === null ? null : m.when(law.ownerId, w))
      const event = (id: string | null) => (id === null ? null : m.event(id))
      const [enactedBy, repealedBy] = [p.enactedBy === undefined ? undefined : event(p.enactedBy), p.repealedBy === undefined ? undefined : event(p.repealedBy)]
      const patch: LawPatch = stripUndefined({
        name: p.name,
        kind: p.kind,
        summary: p.says,
        penalty: p.penalty,
        start: p.enacted !== undefined ? date(p.enacted) : enactedBy ? enactedBy.start : undefined,
        end: p.repealed !== undefined ? date(p.repealed) : repealedBy ? (repealedBy.end ?? repealedBy.start) : undefined,
        startEventId: enactedBy === undefined ? undefined : (enactedBy?.id ?? null),
        endEventId: repealedBy === undefined ? undefined : (repealedBy?.id ?? null),
        notes: p.notes === undefined ? undefined : textToHtml(p.notes),
        tags: p.tags
      })
      return write(ctx, [{ type: 'law.update', payload: { id: law.id, patch } }], `Changed the law ${p.name ?? law.name}`)
    }
  }),
  operation({
    name: 'remove_law',
    title: 'Strike a law out',
    description: 'Deletes a law (by its id from list_laws) as if it had never been; undoable in the app. To have it end at a date instead, use update_law with `repealed`.',
    input: z.object({ lawId: z.string() }),
    route: { method: 'POST', path: '/laws/:lawId/remove' },
    write: true,
    destructive: true,
    run: (ctx, { lawId }) => {
      const law = findOr404(ctx.models.data().timeline.laws, lawId, 'law')
      return write(ctx, [{ type: 'law.delete', payload: { id: law.id } }], `Struck out the law ${law.name}`)
    }
  })
]
