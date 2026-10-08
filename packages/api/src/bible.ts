import { biomeName, describeCalendar, describeCharacter, describeEvent, describeStructure, nodePath } from './describe'
import type { ApiContext } from './operation'
import { htmlToText } from './text'

/**
 * A world written up as one document (PLAN.md §6.1's "world bible"): what a
 * writer, or an AI, needs to know it. Everything is as of the world's "now",
 * and history is in time order. As JSON, the same sections as data.
 */
export async function exportWorldBible(ctx: ApiContext, worldId: string, format: 'markdown' | 'json'): Promise<string | BibleData> {
  const bible = await bibleData(ctx, worldId)
  return format === 'json' ? bible : markdown(bible)
}

type BibleData = Awaited<ReturnType<typeof bibleData>>

async function bibleData({ models: m }: ApiContext, worldId: string) {
  const view = m.world(worldId)
  const now = m.now(worldId)
  const regions = view.regions
  const { curves } = await m.structures(worldId)
  const cal = m.calendar(worldId)
  const t = view.timeline
  const name = (id: string) => t.lifeforms.find((s) => s.id === id)?.name ?? '?'
  return {
    world: view.node.name,
    path: nodePath(m.data().nodes, worldId),
    now: m.date(worldId, now, 'year'),
    notes: htmlToText(view.node.notes),
    calendar: describeCalendar(cal),
    surface: { radiusKm: view.info.settings.radiusKm, landform: view.info.settings.terrain.landform, seed: view.info.settings.seedText },
    regions: regions.map((r) => ({ name: r.name, notes: htmlToText(r.notes) })),
    eras: [...t.eras].sort((a, b) => a.start - b.start).map((e) => ({ name: e.name, when: m.spanDates(worldId, e) })),
    history: [...t.events].sort((a, b) => a.start - b.start).map((e) => describeEvent(m, view, e, regions, true)),
    structures: t.structures.map((s) => ({ ...describeStructure(m, view, s, curves.get(s.id), now, regions), notes: htmlToText(s.notes) })),
    characters: t.characters.map((c) => ({ ...describeCharacter(m, c, now, regions), notes: htmlToText(c.notes) })),
    species: t.lifeforms.map((s) => ({
      name: s.name,
      kind: s.kind,
      diet: s.diet,
      biomes: s.biomes.map(biomeName),
      eats: t.ecolinks.filter((l) => l.type === 'eats' && l.fromId === s.id).map((l) => name(l.toId)),
      notes: htmlToText(s.notes)
    })),
    themes: t.themeSpans
      .map((sp) => ({ span: sp, theme: t.themes.find((x) => x.id === sp.themeId) }))
      .filter((x) => x.theme)
      .sort((a, b) => a.span.start - b.span.start)
      .map(({ span, theme }) => ({
        name: theme!.name,
        when: m.spanDates(worldId, span),
        ...(span.regionId && { region: regions.find((r) => r.id === span.regionId)?.name }),
        mood: theme!.mood,
        style: theme!.style
      }))
  }
}

function markdown(b: BibleData): string {
  const out: string[] = [`# ${b.world}`, '', `*${b.path}* · as of ${b.now}`, '']
  const section = (title: string, lines: string[]) => lines.length && out.push(`## ${title}`, '', ...lines, '')
  const para = (text: string) => (text ? [text, ''] : [])
  out.push(...para(b.notes))
  section('The world', [
    `- Radius ${b.surface.radiusKm.toLocaleString('en')} km, ${b.surface.landform}${b.surface.seed ? `, grown from the seed “${b.surface.seed}”` : ''}`,
    `- A year of ${b.calendar.daysPerYear} days of ${b.calendar.hoursPerDay} hours: ${b.calendar.months.join(', ')}`
  ])
  section('Regions', b.regions.flatMap((r) => [`### ${r.name}`, '', ...para(r.notes)]))
  section('Eras', b.eras.map((e) => `- **${e.name}**, ${e.when}`))
  section(
    'History',
    b.history.flatMap((e) => [
      `### ${e.when}: ${e.title}`,
      '',
      ...[e.where && `Where: ${e.where.join(', ')}`, e.group && `Part of: ${e.group}`, e.tags && `Tags: ${e.tags.join(', ')}`].filter((x): x is string => !!x).map((x) => `*${x}*  `),
      ...(e.where || e.group || e.tags ? [''] : []),
      ...para(e.notes ?? '')
    ])
  )
  section(
    'Structures',
    b.structures.flatMap((s) => [
      `### ${s.name}`,
      '',
      `*${s.blueprint}, built ${s.built}${s.region ? `, in ${s.region}` : ''}. ${s.standing ? `${s.stage} (${s.condition}/100), ${s.maintained ? 'maintained' : 'left to weather'}` : 'Gone'}.*`,
      '',
      ...para(s.notes)
    ])
  )
  section(
    'Characters',
    b.characters.flatMap((c) => [`### ${c.name}`, '', `*Born ${c.born}${c.died ? `, died ${c.died}` : ''}${c.alive && c.region ? `; now in ${c.region}` : ''}.*`, '', ...para(c.notes)])
  )
  section(
    'Life',
    b.species.flatMap((s) => [`### ${s.name}`, '', `*${s.kind}, ${s.diet}${s.biomes.length ? `; lives in ${s.biomes.join(', ')}` : ''}${s.eats.length ? `; eats ${s.eats.join(', ')}` : ''}.*`, '', ...para(s.notes)])
  )
  section(
    'Ages and their tone',
    b.themes.flatMap((th) => [`### ${th.name}, ${th.when}${th.region ? ` (${th.region})` : ''}`, '', ...(th.mood.length ? [`*${th.mood.join(' · ')}*`, ''] : []), ...para(th.style)])
  )
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
