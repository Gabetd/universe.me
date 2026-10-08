import { beforeEach, describe, expect, it } from 'vitest'
import { CommandBus, MemoryStore, THEME_PRESETS, createRootUniverse, fromParts, hexToRgb01, spanWeight, themeAt, type Command } from './index'

let store: MemoryStore
let bus: CommandBus
let rootId: string
let worldId: string
const year = (y: number) => fromParts({ year: y })

beforeEach(() => {
  store = new MemoryStore()
  let n = 0
  bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 1 } })
  rootId = createRootUniverse(store, 'U').id
  const make = (parentId: string, kind: string) => bus.execute({ type: 'node.create', payload: { parentId, kind } }).targetId!
  worldId = make(make(make(make(make(rootId, 'galaxy_cluster'), 'galaxy'), 'star_system'), 'body'), 'world')
})

const run = (type: string, payload: object) => bus.execute({ type, payload } as Command)
const theme = (preset?: string, extra: object = {}) => run('theme.create', { ownerId: rootId, preset, ...extra }).targetId!
const span = (themeId: string, start: number, end: number, extra: object = {}) => run('themeSpan.create', { ownerId: worldId, themeId, start, end, ...extra }).targetId!
const look = (t: number, regionIds?: string[]) => themeAt(store.records('themeSpan').all(), store.records('theme').all(), t, regionIds)

describe('themes', () => {
  it('start from a preset, or from scratch, and edit like any record', () => {
    const golden = theme('Golden Age')
    expect(store.records('theme').get(golden)).toMatchObject({ name: 'Golden Age', lighting: 'golden', mood: THEME_PRESETS['Golden Age']!.mood })
    const own = theme(undefined, { name: 'Mine' })
    expect(store.records('theme').get(own)).toMatchObject({ name: 'Mine', mood: [], style: '' })
    run('theme.update', { id: own, patch: { palette: { sky: '#000000', water: '#111111', land: '#222222', accent: '#333333' } } })
    bus.undo()
    expect(store.records('theme').get(own)!.palette.sky).not.toBe('#000000')
    expect(() => theme('Nope')).toThrow(/no Nope theme/)
  })

  it('spans need a theme, a world, an order in time, and a region on that world', () => {
    const t = theme('Ice Age')
    expect(() => span(t, year(10), year(5))).toThrow(/end before it starts/)
    expect(() => span('missing', year(1), year(5))).toThrow()
    expect(() => run('themeSpan.create', { ownerId: rootId, themeId: t, start: 0, end: 1 })).toThrow(/not a world/)
    const regionId = run('region.create', { worldId, name: 'North', points: [{ lat: 50, lon: 0 }, { lat: 50, lon: 10 }, { lat: 60, lon: 5 }] }).targetId!
    expect(store.records('themeSpan').get(span(t, year(1), year(5), { regionId }))!.regionId).toBe(regionId)
  })

  it('deleting a theme takes its spans with it, and undo brings both back', () => {
    const t = theme('Twilight')
    span(t, year(1), year(2))
    span(t, year(3), year(4))
    run('theme.delete', { id: t })
    expect(store.records('themeSpan').all()).toHaveLength(0)
    bus.undo()
    expect(store.records('themeSpan').all()).toHaveLength(2)
    expect(store.records('theme').all()).toHaveLength(1)
  })
})

describe('blending at the playhead', () => {
  it('a span fades in over its blend-in and out over its blend-out', () => {
    const s = { start: 0, end: 100, blendIn: 20, blendOut: 50 }
    expect(spanWeight(s, -1)).toBe(0)
    expect(spanWeight(s, 0)).toBe(0)
    expect(spanWeight(s, 10)).toBeCloseTo(0.5)
    expect(spanWeight(s, 30)).toBe(1)
    expect(spanWeight(s, 75)).toBeCloseTo(0.5)
    expect(spanWeight(s, 101)).toBe(0)
    // No blend times: on for the whole span.
    expect(spanWeight({ start: 0, end: 10, blendIn: 0, blendOut: 0 }, 0)).toBe(1)
  })

  it('shows the theme in force, crossfading where spans overlap, higher priority on top', () => {
    const golden = theme('Golden Age')
    const plague = theme('Plague Years')
    span(golden, year(1000), year(1300), { blendOut: year(1300) - year(1250) })
    span(plague, year(1250), year(1400), { blendIn: year(1300) - year(1250), priority: 1 })
    expect(look(year(900))).toBeUndefined()
    const before = look(year(1100))!
    expect(before.dominant.name).toBe('Golden Age')
    expect(before.strength).toBe(1)
    expect(before.sky).toEqual(hexToRgb01(THEME_PRESETS['Golden Age']!.palette.sky))
    // Halfway through the crossfade, half of each.
    const middle = look(year(1275))!
    expect(middle.strength).toBeCloseTo(1 - 0.5 * 0.5)
    const sky = (name: string) => hexToRgb01(THEME_PRESETS[name]!.palette.sky)[0]
    expect(middle.sky[0]).toBeGreaterThan(Math.min(sky('Golden Age'), sky('Plague Years')))
    expect(middle.sky[0]).toBeLessThan(Math.max(sky('Golden Age'), sky('Plague Years')))
    expect(middle.layers.map((l) => l.theme.name).sort()).toEqual(['Golden Age', 'Plague Years'])
    expect(look(year(1350))!.dominant.name).toBe('Plague Years')
  })

  it('a span for a region only applies there', () => {
    const regionId = run('region.create', { worldId, name: 'Marsh', points: [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 10, lon: 5 }] }).targetId!
    span(theme('Verdant'), year(1), year(10))
    span(theme('Plague Years'), year(1), year(10), { regionId, priority: 5 })
    expect(look(year(5))!.dominant.name).toBe('Verdant')
    expect(look(year(5), [regionId])!.dominant.name).toBe('Plague Years')
  })
})
