import { describe, expect, it } from 'vitest'
import { htmlToText, textToHtml } from './text'

describe('notes as text', () => {
  it('round-trip paragraphs, line breaks and lists', () => {
    const text = 'The walls gave way.\nSmoke rose.\n\n- Tarn\n- Velm\n\nNo one returned & <none> wept.'
    expect(textToHtml(text)).toBe('<p>The walls gave way.<br>Smoke rose.</p><ul><li><p>Tarn</p></li><li><p>Velm</p></li></ul><p>No one returned &amp; &lt;none&gt; wept.</p>')
    expect(htmlToText(textToHtml(text))).toBe(text)
  })

  it('read what the editor writes', () => {
    expect(htmlToText('<h2>Origins</h2><p>Built by <strong>giants</strong>.</p>')).toBe('Origins\n\nBuilt by giants.')
    expect(htmlToText('')).toBe('')
    expect(htmlToText('<ul><li> <p>One</p></li><li>Two</li></ul>')).toBe('- One\n- Two')
    expect(htmlToText('a < b, and <unclosed')).toBe('a < b, and <unclosed')
  })

  it('take time in step with a note’s length, whatever is in it', () => {
    for (const hostile of ['<li'.repeat(300_000), '<li><p'.repeat(200_000), '<'.repeat(1_000_000), `<${'a'.repeat(1_000_000)}`]) {
      const start = performance.now()
      htmlToText(hostile)
      expect(performance.now() - start, hostile.slice(0, 12)).toBeLessThan(500)
    }
  })
})
