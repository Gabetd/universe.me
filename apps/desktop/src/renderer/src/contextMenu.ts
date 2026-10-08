import { eventPlace, type SpatialNode } from '@universe/core'
import { create } from 'zustand'
import { addOptions, kindLabel } from './kinds'
import { deleteCommand, useUi, type DeleteKind } from './store'
import { useTimelineView } from './timeline/timelineStore'
import { goToEvent } from './world/goToEvent'

/**
 * Right-click menus (one at a time, shown by `ContextMenuHost`): the options
 * for an element, wherever it's shown — the universe tree, the timeline, a
 * world's views, the inspector's lists. An element in the page says what it
 * is with `data-menu={menuRef(kind, id)}`; a canvas or a 3D view, which knows
 * what's under the pointer itself, calls `openElementMenu`.
 */

/** What can be right-clicked: a node, or a record a world or timeline holds. */
export type ElementKind = 'node' | 'region' | 'structure' | 'character' | 'event' | 'era' | 'group' | 'link' | 'theme' | 'themeSpan' | 'species' | 'lane'

export interface ElementRef {
  kind: ElementKind
  id: string
}

export type MenuItem = { label: string; run(): void; danger?: boolean } | 'separator'

export interface Menu {
  x: number
  y: number
  title?: string
  items: MenuItem[]
}

export const useContextMenu = create<{ menu: Menu | null; open(menu: Menu): void; close(): void }>((set) => ({
  menu: null,
  open: (menu) => set({ menu }),
  close: () => set({ menu: null })
}))

/** The value of an element's `data-menu` attribute. */
export const menuRef = (kind: ElementKind, id: string) => `${kind}:${id}`

/** The element a `data-menu` value names, if it's one. */
export function parseMenuRef(value: string | undefined): ElementRef | undefined {
  const at = value?.indexOf(':') ?? -1
  if (!value || at < 1) return undefined
  const kind = value.slice(0, at) as ElementKind
  return KINDS[kind] ? { kind, id: value.slice(at + 1) } : undefined
}

/** For each kind: what it's called, where its records are, how it's deleted and the inspector field that renames it. */
const KINDS: Record<ElementKind, { label: string; nameField?: string; deleteAs: DeleteKind }> = {
  node: { label: 'Node', nameField: 'Name', deleteAs: 'node' },
  region: { label: 'Region', nameField: 'Region name', deleteAs: 'region' },
  structure: { label: 'Structure', nameField: 'Structure name', deleteAs: 'structure' },
  character: { label: 'Character', nameField: 'Character name', deleteAs: 'character' },
  event: { label: 'Event', nameField: 'Event title', deleteAs: 'event' },
  era: { label: 'Era', nameField: 'Era name', deleteAs: 'era' },
  group: { label: 'Group', nameField: 'Group title', deleteAs: 'group' },
  link: { label: 'Link', deleteAs: 'link' },
  theme: { label: 'Theme', nameField: 'Theme name', deleteAs: 'theme' },
  themeSpan: { label: 'Theme span', deleteAs: 'themeSpan' },
  species: { label: 'Species', nameField: 'Species name', deleteAs: 'species' },
  lane: { label: 'Lane', deleteAs: 'lane' }
}

/** An element's name, as the menu's title shows it; undefined if it no longer exists. */
function nameOf({ kind, id }: ElementRef): string | undefined {
  const s = useUi.getState()
  const t = s.timeline
  const find = <T extends { id: string }>(list: T[]) => list.find((r) => r.id === id)
  switch (kind) {
    case 'node':
      return find(s.nodes)?.name
    case 'region':
      return find(s.regions)?.name
    case 'structure':
      return find(t.structures)?.name
    case 'character':
      return find(t.characters)?.name
    case 'event':
      return find(t.events)?.title
    case 'era':
      return find(t.eras)?.name
    case 'group':
      return find(t.groups)?.title
    case 'theme':
      return find(t.themes)?.name
    case 'species':
      return find(t.lifeforms)?.name
    case 'lane':
      return find(t.lanes)?.name
    case 'link': {
      const link = find(t.links)
      const title = (eventId: string) => t.events.find((e) => e.id === eventId)?.title ?? '?'
      return link && `${title(link.fromId)} → ${title(link.toId)}`
    }
    case 'themeSpan': {
      const span = find(t.themeSpans)
      return span && (t.themes.find((x) => x.id === span.themeId)?.name ?? 'Theme')
    }
  }
}

/** Shows an element in the inspector (where it has a panel), as clicking it does. */
export function openElement({ kind, id }: ElementRef): void {
  const ui = useUi.getState()
  if (kind === 'node') ui.select(id)
  else if (kind === 'region') ui.selectRegion(id)
  else if (kind === 'structure') ui.selectStructure(id)
  else if (kind === 'character') ui.selectCharacter(id)
  else if (kind === 'event' || kind === 'era' || kind === 'group' || kind === 'link' || kind === 'theme' || kind === 'themeSpan') ui.selectTimeline({ kind, ids: [id] })
}

/** Opens an element (`open`) and puts the cursor in its name, once its panel is there. */
function rename(open: () => void, field: string): void {
  open()
  const focus = (tries: number) =>
    requestAnimationFrame(() => {
      const input = [...document.querySelectorAll<HTMLInputElement>('label.field')].find((l) => l.firstElementChild?.textContent === field)?.querySelector('input')
      if (input) {
        input.focus()
        input.select()
      } else if (tries > 0) focus(tries - 1)
    })
  focus(10)
}

const execute = (command: Parameters<ReturnType<typeof useUi.getState>['execute']>[0] | undefined) => void (command && useUi.getState().execute(command))

/** Options only some kinds have: going somewhere, adding to it, following a link. */
function kindItems({ kind, id }: ElementRef): MenuItem[] {
  const s = useUi.getState()
  const t = s.timeline
  if (kind === 'node') {
    const node = s.nodes.find((n) => n.id === id)
    if (!node) return []
    const adds = addOptions(node, s.nodes).map(({ kind: child, label }) => ({
      label: `Add ${label.toLowerCase()}`,
      run: () => execute({ type: 'node.create', payload: { parentId: node.id, kind: child, name: `New ${label}` } })
    }))
    return adds.length ? ['separator', ...adds] : []
  }
  if (kind === 'event') {
    const event = t.events.find((e) => e.id === id)
    if (!event) return []
    return [
      { label: 'Move the playhead here', run: () => useTimelineView.getState().setPlayhead(event.ownerId, event.start) },
      ...(eventPlace(event, s.regions) ? [{ label: 'Show where it happened', run: () => goToEvent(event) }] : [])
    ]
  }
  if (kind === 'link') {
    const link = t.links.find((l) => l.id === id)
    if (!link) return []
    return [
      { label: 'Go to the cause', run: () => s.selectTimeline({ kind: 'event', ids: [link.fromId] }) },
      { label: 'Go to the effect', run: () => s.selectTimeline({ kind: 'event', ids: [link.toId] }) }
    ]
  }
  if (kind === 'themeSpan') {
    const span = t.themeSpans.find((x) => x.id === id)
    return span ? [{ label: 'Edit its theme', run: () => s.selectTimeline({ kind: 'theme', ids: [span.themeId] }) }] : []
  }
  return []
}

/** Whether a node is the universe itself, which can't be deleted. */
const isRoot = (node: SpatialNode | undefined) => !!node && node.id === useUi.getState().project?.rootId

/** What only the view an element is shown in can do with it: open it there (a species in the food web), or more (renaming a lane in place). */
export interface MenuOptions {
  open?: () => void
  extra?: MenuItem[]
}

/** Kinds shown in the inspector, which `openElement` opens. */
const IN_INSPECTOR = new Set<ElementKind>(['node', 'region', 'structure', 'character', 'event', 'era', 'group', 'link', 'theme', 'themeSpan'])

/** The menu for an element: open it, rename it, what its kind offers, and delete it (undoable, like every change). */
export function elementMenu(ref: ElementRef, { open, extra = [] }: MenuOptions = {}): Omit<Menu, 'x' | 'y'> | undefined {
  const name = nameOf(ref)
  if (name === undefined) return undefined
  const spec = KINDS[ref.kind]
  const node = ref.kind === 'node' ? useUi.getState().nodes.find((n) => n.id === ref.id) : undefined
  const label = node ? kindLabel(node, useUi.getState().nodes) : spec.label
  const show = open ?? (IN_INSPECTOR.has(ref.kind) ? () => openElement(ref) : undefined)
  const items: MenuItem[] = [
    ...(show ? [{ label: open || ref.kind === 'node' ? 'Open' : 'Open in the inspector', run: show }] : []),
    ...(show && spec.nameField ? [{ label: 'Rename…', run: () => rename(show, spec.nameField!) }] : []),
    ...extra,
    ...kindItems(ref)
  ]
  if (!isRoot(node)) items.push('separator', { label: `Delete ${name}`, danger: true, run: () => execute(deleteCommand(spec.deleteAs, [ref.id])) })
  return { title: `${label} · ${name}`, items }
}

/** Opens an element's menu at a point on screen (from a canvas or a 3D view, which know what's under the pointer). */
export function openElementMenu(ref: ElementRef, x: number, y: number, options?: MenuOptions): void {
  const menu = elementMenu(ref, options)
  if (menu) useContextMenu.getState().open({ ...menu, x, y })
}
