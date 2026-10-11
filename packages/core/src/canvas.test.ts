import { beforeEach, describe, expect, it } from 'vitest'
import { CommandBus, MemoryStore, canvasColor, createRootUniverse, inGroup, type Command } from './index'

let store: MemoryStore
let bus: CommandBus
let worldId: string
let otherId: string

beforeEach(() => {
  store = new MemoryStore()
  let n = 0
  bus = new CommandBus(store, { context: { newId: () => `id-${++n}`, randomSeed: () => 1 } })
  const make = (parentId: string, kind: string) => bus.execute({ type: 'node.create', payload: { parentId, kind } }).targetId!
  const system = make(make(make(createRootUniverse(store, 'U').id, 'galaxy_cluster'), 'galaxy'), 'star_system')
  worldId = make(make(system, 'body'), 'world')
  otherId = make(make(system, 'body'), 'world')
})

const run = (type: string, payload: object) => bus.execute({ type, payload } as Command)
const card = (id: string) => store.records('card').get(id)
const connection = (id: string) => store.records('connection').get(id)
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('the canvas’s cards', () => {
  it('are text, an element, a picture, a web link or a group, each of its kind’s size unless given one, and changed and deleted a step of undo at a time', () => {
    run('card.create', { id: 'note', ownerId: worldId, kind: 'text', x: 10, y: 20, text: '# Omens\nThe **red** comet' })
    expect(card('note')).toMatchObject({ ownerId: worldId, kind: 'text', x: 10, y: 20, w: 260, h: 140, color: null, text: '# Omens\nThe **red** comet', target: null })
    run('card.create', { id: 'who', ownerId: worldId, kind: 'element', x: 0, y: 0, target: { kind: 'node', id: otherId } })
    run('card.create', { id: 'pic', ownerId: worldId, kind: 'image', x: 0, y: 0, w: 100, h: 80, image: PIXEL })
    run('card.create', { id: 'web', ownerId: worldId, kind: 'link', x: 0, y: 0, url: 'https://example.com/maps' })
    run('card.create', { id: 'box', ownerId: worldId, kind: 'group', x: -50, y: -50, text: 'The north', color: '4' })
    expect(card('pic')).toMatchObject({ w: 100, h: 80, image: PIXEL })
    expect(canvasColor(card('box')!.color)).toBe('#46a758')
    expect(canvasColor('#123456')).toBe('#123456')

    run('card.update', { id: 'note', patch: { x: 300, w: 400, color: '#ff00aa' } })
    expect(card('note')).toMatchObject({ x: 300, y: 20, w: 400, color: '#ff00aa' })
    bus.undo()
    expect(card('note')).toMatchObject({ x: 10, w: 260, color: null })
    run('card.delete', { id: 'note' })
    expect(card('note')!.deletedAt).not.toBeNull()
    bus.undo()
    expect(card('note')!.deletedAt).toBeNull()
  })

  it('need what their kind shows: something there to show, a web page, a picture; and fit on the board', () => {
    expect(() => run('card.create', { ownerId: worldId, kind: 'element', x: 0, y: 0 })).toThrow('needs something to show')
    expect(() => run('card.create', { ownerId: worldId, kind: 'element', x: 0, y: 0, target: { kind: 'character', id: 'nobody' } })).toThrow()
    expect(() => run('card.create', { ownerId: worldId, kind: 'link', x: 0, y: 0 })).toThrow('needs a web address')
    expect(() => run('card.create', { ownerId: worldId, kind: 'link', x: 0, y: 0, url: 'javascript:alert(1)' })).toThrow()
    expect(() => run('card.create', { ownerId: worldId, kind: 'image', x: 0, y: 0, image: 'data:text/html;base64,PGI+' })).toThrow()
    expect(() => run('card.create', { ownerId: worldId, kind: 'text', x: 0, y: 0, w: 5 })).toThrow()
    expect(() => run('card.create', { ownerId: 'nowhere', kind: 'text', x: 0, y: 0 })).toThrow()
  })

  it('in a group are those lying wholly inside it', () => {
    const group = { id: 'g', x: 0, y: 0, w: 500, h: 300 }
    const cards = [group, { id: 'in', x: 10, y: 10, w: 100, h: 100 }, { id: 'across', x: 450, y: 10, w: 100, h: 100 }, { id: 'out', x: 600, y: 0, w: 50, h: 50 }]
    expect(inGroup(group, cards).map((c) => c.id)).toEqual(['in'])
  })
})

describe('connections', () => {
  beforeEach(() => {
    run('card.create', { id: 'a', ownerId: worldId, kind: 'text', x: 0, y: 0, text: 'A' })
    run('card.create', { id: 'b', ownerId: worldId, kind: 'text', x: 400, y: 0, text: 'B' })
    run('event.create', { id: 'e', ownerId: worldId, title: 'The comet', start: 10 })
  })

  it('join two cards or a card and an event, with a label, a colour, its sides and arrows, changed a step at a time', () => {
    run('connection.create', { id: 'ab', fromId: 'a', toId: 'b', label: 'foretells' })
    expect(connection('ab')).toMatchObject({ ownerId: worldId, fromId: 'a', toId: 'b', label: 'foretells', arrows: 'end', fromSide: null, toSide: null, color: null })
    run('connection.create', { id: 'ae', fromId: 'a', toId: 'e', fromSide: 'right', toSide: 'left', arrows: 'both', color: '1' })
    expect(connection('ae')).toMatchObject({ fromSide: 'right', toSide: 'left', arrows: 'both', color: '1' })
    run('connection.update', { id: 'ab', patch: { label: 'warns of', arrows: 'none' } })
    expect(connection('ab')).toMatchObject({ label: 'warns of', arrows: 'none' })
    bus.undo()
    expect(connection('ab')).toMatchObject({ label: 'foretells', arrows: 'end' })
  })

  it('go with the card or event at either end, and come back with it', () => {
    run('connection.create', { id: 'ab', fromId: 'a', toId: 'b' })
    run('connection.create', { id: 'eb', fromId: 'e', toId: 'b' })
    run('card.delete', { id: 'b' })
    expect(connection('ab')!.deletedAt).not.toBeNull()
    expect(connection('eb')!.deletedAt).not.toBeNull()
    bus.undo()
    expect(connection('ab')!.deletedAt).toBeNull()
    run('event.delete', { id: 'e' })
    expect(connection('eb')!.deletedAt).not.toBeNull()
    expect(connection('ab')!.deletedAt).toBeNull()
  })

  it('join two different things on the same canvas', () => {
    run('card.create', { id: 'far', ownerId: otherId, kind: 'text', x: 0, y: 0 })
    expect(() => run('connection.create', { fromId: 'a', toId: 'a' })).toThrow('itself')
    expect(() => run('connection.create', { fromId: 'a', toId: 'far' })).toThrow('different canvases')
    expect(() => run('connection.create', { fromId: 'a', toId: 'nothing' })).toThrow()
  })

  it('leave an event’s card its size once resized', () => {
    run('event.update', { id: 'e', patch: { canvas: { x: 5, y: 6, w: 320, h: 120 } } })
    expect(store.records('event').get('e')!.canvas).toEqual({ x: 5, y: 6, w: 320, h: 120 })
  })
})
