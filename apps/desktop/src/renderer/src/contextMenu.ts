import { eventPlace } from '@universe/core'
import { create } from 'zustand'
import { addChildCommand, addOptions, canDelete, kindLabel } from './kinds'
import { deleteCommand, useUi } from './store'
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
export type ElementKind = 'node' | 'region' | 'structure' | 'character' | 'event' | 'era' | 'group' | 'link' | 'theme' | 'themeSpan' | 'species' | 'lane' | 'power'

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

/**
 * The right button, as the menu needs it: a right-drag pans the map and turns
 * the globe, so a menu asked for during one (Linux and macOS ask on the press)
 * waits for the release and is dropped if the pointer moved, and one asked for
 * after one (Windows asks on the release) is dropped too.
 */
const right = { down: false, moved: false, x: 0, y: 0, at: 0 }
const DRAG_PX = 4
window.addEventListener(
  'pointerdown',
  (e) => {
    if (e.button !== 2) return
    Object.assign(right, { down: true, moved: false, x: e.clientX, y: e.clientY, at: performance.now() })
  },
  true
)
window.addEventListener(
  'pointermove',
  (e) => {
    if (!right.down || right.moved || Math.hypot(e.clientX - right.x, e.clientY - right.y) <= DRAG_PX) return
    right.moved = true
    useContextMenu.setState({ waiting: null })
  },
  true
)
window.addEventListener(
  'pointerup',
  (e) => {
    if (e.button !== 2) return
    right.down = false
    const { waiting } = useContextMenu.getState()
    if (waiting) useContextMenu.setState({ waiting: null, menu: right.moved ? null : waiting })
  },
  true
)

/** Whether a menu asked for now comes from the keyboard (the menu key, Shift+F10) rather than a right-click. */
export const fromKeyboard = () => !right.down && performance.now() - right.at > 1000

interface MenuState {
  menu: Menu | null
  /** One asked for while the right button is down, shown once it's let go without dragging. */
  waiting: Menu | null
  /** A name field to put the cursor in once it's shown (see `rename`). */
  focusField: { label: string; at: number } | null
  open(menu: Menu): void
  close(): void
}

export const useContextMenu = create<MenuState>((set) => ({
  menu: null,
  waiting: null,
  focusField: null,
  open: (menu) => {
    if (right.down) return set({ waiting: menu, menu: null })
    // Asked for at the end of a right-drag: the drag was what was meant.
    const dragged = right.moved && performance.now() - right.at < 10_000
    right.moved = false
    set({ menu: dragged ? null : menu, waiting: null })
  },
  close: () => set({ menu: null, waiting: null })
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

/**
 * For each kind (each deleted by its own `<kind>.delete`): what it's called,
 * the field that renames it, and whether the inspector shows it (`openElement`).
 */
const KINDS: Record<ElementKind, { label: string; nameField?: string; inspector: boolean }> = {
  node: { label: 'Node', nameField: 'Name', inspector: true },
  region: { label: 'Region', nameField: 'Region name', inspector: true },
  structure: { label: 'Structure', nameField: 'Structure name', inspector: true },
  character: { label: 'Character', nameField: 'Character name', inspector: true },
  event: { label: 'Event', nameField: 'Event title', inspector: true },
  era: { label: 'Era', nameField: 'Era name', inspector: true },
  group: { label: 'Group', nameField: 'Group title', inspector: true },
  link: { label: 'Link', inspector: true },
  theme: { label: 'Theme', nameField: 'Theme name', inspector: true },
  themeSpan: { label: 'Theme span', inspector: true },
  species: { label: 'Species', nameField: 'Species name', inspector: false },
  lane: { label: 'Lane', inspector: false },
  power: { label: 'Power system', nameField: 'Power system name', inspector: false }
}

/** An element's name, as the menu's title shows it; undefined if it no longer exists. */
export function nameOf({ kind, id }: ElementRef): string | undefined {
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
    case 'power':
      return find(t.powers)?.name
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

/** Shows an element in the inspector (where `KINDS` says it has a panel), as clicking it does. */
export function openElement({ kind, id }: ElementRef): void {
  const ui = useUi.getState()
  if (kind === 'node') ui.select(id)
  else if (kind === 'region') ui.selectRegion(id)
  else if (kind === 'structure') ui.selectStructure(id)
  else if (kind === 'character') ui.selectCharacter(id)
  else if (kind !== 'species' && kind !== 'lane' && kind !== 'power') ui.selectTimeline({ kind, ids: [id] })
}

/** How long a request for a name field waits for its panel to appear. */
const FOCUS_WAIT_MS = 3000

/** Opens an element (`open`) and asks its name field (labelled `field`) to take the cursor once its panel is there. */
function rename(open: () => void, field: string): void {
  open()
  useContextMenu.setState({ focusField: { label: field, at: performance.now() } })
}

/** For a text field labelled `label`: whether a rename is waiting for it; taking it (only one field does) clears it. */
export function takeFocusRequest(label: string): boolean {
  const request = useContextMenu.getState().focusField
  if (request?.label !== label || performance.now() - request.at > FOCUS_WAIT_MS) return false
  useContextMenu.setState({ focusField: null })
  return true
}

const execute = (command: Parameters<ReturnType<typeof useUi.getState>['execute']>[0] | undefined) => void (command && useUi.getState().execute(command))

/** Options only some kinds have: going somewhere, adding to it, following a link. */
function kindItems({ kind, id }: ElementRef): MenuItem[] {
  const s = useUi.getState()
  const t = s.timeline
  if (kind === 'node') {
    const node = s.nodes.find((n) => n.id === id)
    if (!node) return []
    const adds = addOptions(node, s.nodes).map(({ kind: child, label }) => ({ label: `Add ${label.toLowerCase()}`, run: () => execute(addChildCommand(node, child, label)) }))
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

/** What only the view an element is shown in can do with it: open it there (a species in the food web), or more (renaming a lane in place). */
export interface MenuOptions {
  open?: () => void
  extra?: MenuItem[]
}

/** The menu for an element: open it, rename it, what its kind offers, and delete it (undoable, like every change). */
export function elementMenu(ref: ElementRef, { open, extra = [] }: MenuOptions = {}): Omit<Menu, 'x' | 'y'> | undefined {
  const name = nameOf(ref)
  if (name === undefined) return undefined
  const spec = KINDS[ref.kind]
  const node = ref.kind === 'node' ? useUi.getState().nodes.find((n) => n.id === ref.id) : undefined
  const label = node ? kindLabel(node, useUi.getState().nodes) : spec.label
  const show = open ?? (spec.inspector ? () => openElement(ref) : undefined)
  const items: MenuItem[] = [
    ...(show ? [{ label: open || ref.kind === 'node' ? 'Open' : 'Open in the inspector', run: show }] : []),
    ...(show && spec.nameField ? [{ label: 'Rename…', run: () => rename(show, spec.nameField!) }] : []),
    ...extra,
    ...kindItems(ref)
  ]
  if (!node || canDelete(node)) items.push('separator', { label: `Delete ${name}`, danger: true, run: () => execute(deleteCommand(ref.kind, [ref.id])) })
  return { title: `${label} · ${name}`, items }
}

/** Opens an element's menu at a point on screen (from a canvas or a 3D view, which know what's under the pointer). */
export function openElementMenu(ref: ElementRef, x: number, y: number, options?: MenuOptions): void {
  const menu = elementMenu(ref, options)
  if (menu) useContextMenu.getState().open({ ...menu, x, y })
}
