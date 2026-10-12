import { describe, expect, it } from 'vitest'
import { linesOf, mergeCells, mergeLines } from './line-merge'
import { descends, joined, meeting } from './lineage'

describe('merging changes made apart', () => {
  it('splits notes into lines after paragraphs, items, breaks and new lines', () => {
    expect(linesOf('<p>a</p><ul><li>b</li></ul>c<br>d\ne')).toEqual(['<p>a</p>', '<ul><li>b</li>', '</ul>', 'c<br>', 'd\n', 'e'])
    expect(linesOf('').join('')).toBe('')
  })

  it('takes each side’s lines, a change made alike once, and the later where both changed a line', () => {
    const base = 'a\nb\nc\nd\n'
    expect(mergeLines(base, 'A\nb\nc\nd\n', 'a\nb\nc\nD\n')).toEqual({ text: 'A\nb\nc\nD\n', clean: true })
    expect(mergeLines(base, 'a\nb\nc\nd\nadded\n', 'a\nc\nd\n')).toEqual({ text: 'a\nc\nd\nadded\n', clean: true })
    expect(mergeLines(base, 'a\nB\nc\nd\n', 'a\nB\nc\nd\n')).toEqual({ text: 'a\nB\nc\nd\n', clean: true })
    expect(mergeLines(base, 'a\nmine\nc\nd\n', 'a\ntheirs\nc\nd\n')).toEqual({ text: 'a\ntheirs\nc\nd\n', clean: false })
  })

  it('gives up on texts too long to compare', () => {
    const many = (tag: string) => Array.from({ length: 3000 }, (_, i) => `${tag}${i}\n`).join('')
    expect(mergeLines(many('c'), many('a'), many('b'))).toBeUndefined()
  })

  it('takes each cell from the side that changed it, the later where both did', () => {
    const base = new Uint8Array([0, 0, 0, 0, 0, 0])
    expect([...mergeCells(base, new Uint8Array([1, 0, 0, 0, 5, 5]), new Uint8Array([0, 0, 2, 2, 6, 0]), 2)]).toEqual([1, 0, 2, 2, 6, 0])
  })

  it('tells a version made on top of another from one made apart', () => {
    const line = { stamp: 'c', before: ['b', 'a'], from: '0' }
    expect(descends(line, 'a')).toBe(true)
    expect(descends(line, 'x')).toBe(false)
    // Older than what's known: taken as before it.
    expect(descends({ ...line, from: 'b' }, 'a0')).toBe(true)
    // Not known at all: never a conflict.
    expect(descends({ stamp: 'c' }, 'x')).toBe(true)
    expect(meeting(line, { stamp: 'd', before: ['b', 'a'] })).toBe('b')
    expect(meeting(line, { stamp: 'd' })).toBeUndefined()
    expect(joined(line, { stamp: 'd', before: ['b'] })).toEqual(['d', 'c', 'b', 'a'])
  })
})
