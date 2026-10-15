import { FACTION_KIND_LABELS, eventPlace, languageAtPoint, nameIn, SCAR_LOOKS, scarName, waterwayKind, type Command, type FactionKind, type ScarKind, type Language, type LawScope, type Party } from '@universe/core'
import { waterwayIndex, waterwayPlace } from '@universe/procgen'
import { create } from 'zustand'
import { addChildCommand, addOptions, canDelete, kindLabel, opened } from './kinds'
import { deleteCommand, useUi, type DeleteKind } from './store'
import { contributions, isNameable, usePlugins } from './pluginStore'
import { playheadOf, useTimelineView } from './timeline/timelineStore'
import { useEditor } from './world/editorStore'
import { useWaterOf } from './world/useWater'
import { languageNow, nameInPlace, waterInLanguages } from './languages'
import { latLonLabel } from './world/useMapPins'
import { viewUpClose, waterwayLabel } from './world/waterLook'
import { goToEvent } from './world/goToEvent'

/**
 * Right-click menus (one at a time, shown by `ContextMenuHost`): the options
 * for an element, wherever it's shown — the universe tree, the timeline, a
 * world's views, the inspector's lists. An element in the page says what it
 * is with `data-menu={menuRef(kind, id)}`; a canvas or a 3D view, which knows
 * what's under the pointer itself, calls `openElementMenu`.
 */

/** What can be right-clicked: a node, or a record a world or timeline holds. */
export type ElementKind = 'node' | 'region' | 'structure' | 'character' | 'event' | 'era' | 'group' | 'link' | 'theme' | 'themeSpan' | 'species' | 'lane' | 'power' | 'faction' | 'relationship' | 'waterway' | 'member' | 'mapPin' | 'scar' | 'law'

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

/**
 * A finger held still on something is its right-click: a touch screen has no
 * right button, and iOS never sends one. Where the system does (Android, on
 * a long press), that one is used and this one isn't sent.
 */
const LONG_PRESS_MS = 550
let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | undefined
/** When a long press last sent its right-click: the system's own, if one follows, is dropped. */
let pressedAt = -Infinity
const letGo = () => {
  clearTimeout(press?.timer)
  press = undefined
}
window.addEventListener(
  'pointerdown',
  (e) => {
    letGo()
    if (e.pointerType !== 'touch' || !e.isPrimary) return
    const target = e.target as Element
    const { clientX, clientY } = e
    press = {
      x: clientX,
      y: clientY,
      timer: setTimeout(() => {
        press = undefined
        // A press, not a key (the menu opens under the finger), nor the end of a right-drag.
        pressedAt = right.at = performance.now()
        right.moved = false
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY, button: 2 }))
      }, LONG_PRESS_MS)
    }
  },
  true
)
window.addEventListener('pointermove', (e) => press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 2 * DRAG_PX && letGo(), true)
window.addEventListener('pointerup', letGo, true)
window.addEventListener('pointercancel', letGo, true)
window.addEventListener(
  'contextmenu',
  (e) => {
    if (!e.isTrusted) return
    // The system's own long-press menu came first: it's the one.
    letGo()
    if (performance.now() - pressedAt < 1000) {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
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

/** What a kind is called, or the field that renames one: the same for every one of the kind, or by its id. */
type ByKind = string | ((id: string) => string)

/**
 * For each kind (each deleted by its own `<kind>.delete`, unless it can't
 * be): what it's called, the field that renames it, whether the inspector
 * shows it (`openElement`), and what deleting one is called if not that.
 */
const KINDS: Record<ElementKind, { label: ByKind; nameField?: ByKind; inspector: boolean; deletable?: false; deleteVerb?: string }> = {
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
  power: { label: 'Power system', nameField: 'Power system name', inspector: false },
  faction: { label: 'Faction', nameField: 'Faction name', inspector: false },
  relationship: { label: 'Relationship', inspector: false },
  // Made by the land, so never deleted, only given its generated name back.
  waterway: { label: waterwayLabel, nameField: (id) => `${waterwayLabel(id)} name`, inspector: true, deletable: false },
  // Someone the universe is shared with (in the Share dialog): removing them stops sharing it with them.
  member: { label: 'Member', inspector: false, deleteVerb: 'Remove' },
  mapPin: { label: 'Pin', nameField: 'Pin name', inspector: true },
  scar: { label: 'Scar', nameField: 'Scar name', inspector: true },
  law: { label: 'Law', nameField: 'Law name', inspector: true }
}

const byKind = (value: ByKind, id: string) => (typeof value === 'string' ? value : value(id))

/** Whether a kind can be deleted (by `<kind>.delete`). */
const deletable = (kind: ElementKind): kind is ElementKind & DeleteKind => KINDS[kind].deletable !== false

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
    case 'faction':
      return find(t.factions)?.name
    case 'relationship': {
      const rel = find(t.relationships)
      const name = (p: Party) => (p.kind === 'faction' ? t.factions : t.characters).find((x) => x.id === p.id)?.name ?? '?'
      return rel && `${name(rel.from)} and ${name(rel.to)}`
    }
    case 'link': {
      const link = find(t.links)
      const title = (eventId: string) => t.events.find((e) => e.id === eventId)?.title ?? '?'
      return link && `${title(link.fromId)} → ${title(link.toId)}`
    }
    case 'themeSpan': {
      const span = find(t.themeSpans)
      return span && (t.themes.find((x) => x.id === span.themeId)?.name ?? 'Theme')
    }
    case 'waterway':
      return waterwayOf(id)?.name
    case 'member':
      return find(t.members)?.name
    case 'mapPin':
      return find(t.mapPins)?.name
    case 'scar': {
      const scar = find(t.scars)
      return scar && scarName(scar)
    }
    case 'law':
      return find(t.laws)?.name
  }
}

/** A river or lake (by its hydrology id) on the selected world, with what it's called there. */
function waterwayOf(key: string) {
  const { selectedId: worldId, timeline } = useUi.getState()
  const made = worldId ? useWaterOf.getState().byWorld[worldId] : undefined
  if (!made || !worldId) return undefined
  const water = waterInLanguages(worldId, made, useUi.getState().regions)
  const index = waterwayIndex(
    water,
    timeline.waterways.filter((w) => w.ownerId === worldId)
  )
  const found = index.byKey.get(key)
  return found && { found, own: index.own.get(key), worldId, name: index.nameOf(key)! }
}

/** Shows an element in the inspector (where `KINDS` says it has a panel), as clicking it does; a faction on the Factions page, a relationship with its first side. */
export function openElement({ kind, id }: ElementRef): void {
  const ui = useUi.getState()
  if (kind === 'node') {
    // A planet or moon opens on its surface, as its row in the tree does.
    const node = ui.nodes.find((n) => n.id === id)
    ui.select(node ? opened(node, ui.nodes).id : id)
  } else if (kind === 'region') ui.selectRegion(id)
  else if (kind === 'structure') ui.selectStructure(id)
  else if (kind === 'character') ui.selectCharacter(id)
  else if (kind === 'waterway') ui.selectWaterway(id)
  else if (kind === 'faction') showFaction(id)
  else if (kind === 'relationship') {
    const rel = ui.timeline.relationships.find((r) => r.id === id)
    if (rel) openElement(rel.from)
  } else if (kind !== 'species' && kind !== 'lane' && kind !== 'power' && kind !== 'member') ui.selectTimeline({ kind, ids: [id] })
}

/** Puts a pin at a point of a world's surface and opens it with its name ready to type. */
export async function addMapPin(worldId: string, at: { lat: number; lon: number }): Promise<void> {
  const state = await useUi.getState().execute({ type: 'mapPin.create', payload: { ownerId: worldId, name: 'New pin', lat: at.lat, lon: at.lon } })
  const id = state?.focus?.id
  if (id) rename(() => openElement({ kind: 'mapPin', id }), KINDS.mapPin.nameField as string)
}

/** Makes a law of an era or a faction and opens it with its name ready to type. */
export async function addLaw(scope: LawScope): Promise<void> {
  const state = await useUi.getState().execute({ type: 'law.create', payload: { scope, name: 'New law' } })
  const id = state?.focus?.id
  if (id) rename(() => openElement({ kind: 'law', id }), KINDS.law.nameField as string)
}

/** Leaves a scar of a kind at a point of a world's surface, coming at the playhead, and opens it. */
async function leaveScar(worldId: string, at: { lat: number; lon: number }, kind: ScarKind, radiusKm: number): Promise<void> {
  const state = await useUi.getState().execute({ type: 'scar.create', payload: { ownerId: worldId, kind, radiusKm, lat: at.lat, lon: at.lon, start: playheadOf(worldId) } })
  const id = state?.focus?.id
  if (id) openElement({ kind: 'scar', id })
}

/**
 * The menu for a point of a world's surface (right-click on the globe, the
 * map or the ground): what's there, if anything, with Add a pin here.
 */
export function openSurfaceMenu(worldId: string, at: { lat: number; lon: number }, x: number, y: number, hit?: ElementRef): void {
  const add: MenuItem = { label: 'Add a pin here…', run: () => void addMapPin(worldId, at) }
  const { scarKind, scarRadiusKm } = useEditor.getState()
  const scar: MenuItem = { label: `Leave a scar here (${SCAR_LOOKS[scarKind].label.toLowerCase()})…`, run: () => void leaveScar(worldId, at, scarKind, scarRadiusKm) }
  const menu = hit && elementMenu(hit, { extra: [add, scar] })
  useContextMenu.getState().open(menu ? { ...menu, x, y } : { x, y, title: latLonLabel(at), items: [add, scar] })
}

/** Opens a faction on its world's Factions page. */
export const showFaction = (id: string) => useEditor.getState().set({ view: 'factions', factionId: id })

/** Starts a faction on a world (a part of another, if `parentId` is given, at any depth) and opens it. */
export async function addFaction(worldId: string, kind: FactionKind, parentId?: string): Promise<void> {
  // In the world's language if it speaks one, else after what it is.
  const name =
    nameInPlace('faction', { nodeId: worldId }, kind === 'other' ? '' : FACTION_KIND_LABELS[kind]) ??
    (kind === 'other' ? (parentId ? 'New sub-faction' : 'New faction') : `New ${FACTION_KIND_LABELS[kind].toLowerCase()}`)
  const state = await useUi.getState().execute({ type: 'faction.create', payload: { ownerId: worldId, kind, name, ...(parentId && { parentId }) } })
  if (state?.focus?.id) showFaction(state.focus.id)
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
  if (kind === 'faction') {
    const faction = t.factions.find((f) => f.id === id)
    return faction
      ? ['separator', { label: 'Add a sub-faction', run: () => void addFaction(faction.ownerId, 'other', faction.id) }, { label: 'Add a law…', run: () => void addLaw({ kind: 'faction', factionId: id }) }]
      : []
  }
  if (kind === 'era') return t.eras.some((e) => e.id === id) ? ['separator', { label: 'Add a law…', run: () => void addLaw({ kind: 'era', eraId: id }) }] : []
  if (kind === 'waterway') {
    const w = waterwayOf(id)
    if (!w) return []
    return [
      { label: 'View up close', run: () => viewUpClose(w.found) },
      ...(w.own?.name ? ['separator' as const, { label: `Call it ${w.found.name} again`, run: () => execute({ type: 'waterway.set', payload: { worldId: w.worldId, key: id, patch: { name: '' } } }) }] : [])
    ]
  }
  return []
}

/** A new name in the language spoken where it is (core languages.ts), by that language's rule for its kind: planets and other nodes, species, factions, rivers and lakes. */
function languageItems({ kind, id }: ElementRef): MenuItem[] {
  const s = useUi.getState()
  const named = (language: Language | undefined, rename: (language: Language) => Command): MenuItem[] =>
    language ? ['separator', { label: `Name it in ${language.name}`, run: () => execute(rename(language)) }] : []
  const fresh = () => crypto.randomUUID()
  if (kind === 'node') {
    const node = s.nodes.find((n) => n.id === id)
    return node && node.parentId ? named(languageNow({ nodeId: node.id }), (l) => ({ type: 'node.update', payload: { id, patch: { name: nameIn(l, 'planet', fresh()) } } })) : []
  }
  if (kind === 'species') {
    const species = s.timeline.lifeforms.find((x) => x.id === id)
    return species ? named(languageNow({ nodeId: species.ownerId }), (l) => ({ type: 'species.update', payload: { id, patch: { name: nameIn(l, 'species', fresh()) } } })) : []
  }
  if (kind === 'faction') {
    const faction = s.timeline.factions.find((f) => f.id === id)
    if (!faction) return []
    const kindWord = faction.kind === 'other' ? '' : FACTION_KIND_LABELS[faction.kind]
    return named(languageNow({ nodeId: faction.ownerId }), (l) => ({ type: 'faction.update', payload: { id, patch: { name: nameIn(l, 'faction', fresh(), kindWord) } } }))
  }
  if (kind === 'waterway') {
    const w = waterwayOf(id)
    if (!w) return []
    const language = languageAtPoint(w.worldId, waterwayPlace(w.found), s.regions, s.timeline.languageUses, s.timeline.languages, (n) => s.nodes.find((x) => x.id === n)?.parentId)
    return named(language, (l) => ({ type: 'waterway.set', payload: { worldId: w.worldId, key: id, patch: { name: nameIn(l, waterwayKind(id) === 'lake' ? 'lake' : 'river', fresh()) } } }))
  }
  return []
}

/** Names for it from the name generators that name its kind (PLAN.md §9, M16). */
function nameItems({ kind, id }: ElementRef): MenuItem[] {
  if (!isNameable(kind)) return []
  const namers = contributions(usePlugins.getState().list, 'names').filter(({ contribution }) => contribution.for.includes(kind))
  return namers.length ? ['separator', ...namers.map(({ plugin, contribution }) => ({ label: `Name it: ${contribution.title}…`, run: () => void usePlugins.getState().nameWith({ kind, id }, plugin, contribution) }))] : []
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
  const label = node ? kindLabel(node, useUi.getState().nodes) : byKind(spec.label, ref.id)
  const show = open ?? (spec.inspector ? () => openElement(ref) : undefined)
  const items: MenuItem[] = [
    ...(show ? [{ label: open || ref.kind === 'node' ? 'Open' : 'Open in the inspector', run: show }] : []),
    ...(show && spec.nameField ? [{ label: 'Rename…', run: () => rename(show, byKind(spec.nameField!, ref.id)) }] : []),
    ...extra,
    ...kindItems(ref),
    ...languageItems(ref),
    ...nameItems(ref)
  ]
  const { kind } = ref
  if (deletable(kind) && (!node || canDelete(node))) {
    items.push(...(items.length ? ['separator' as const] : []), { label: `${spec.deleteVerb ?? 'Delete'} ${name}`, danger: true, run: () => execute(deleteCommand(kind, [ref.id])) })
  }
  return { title: `${label} · ${name}`, items }
}

/** Opens an element's menu at a point on screen (from a canvas or a 3D view, which know what's under the pointer). */
export function openElementMenu(ref: ElementRef, x: number, y: number, options?: MenuOptions): void {
  const menu = elementMenu(ref, options)
  if (menu) useContextMenu.getState().open({ ...menu, x, y })
}
