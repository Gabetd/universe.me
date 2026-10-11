import { describe, expect, it } from 'vitest'
import { firstLine, markdownToHtml } from './markdown'

describe('a text card’s Markdown', () => {
  it('shows headings, marks, lists, tasks, quotes, code, rules and links', () => {
    expect(markdownToHtml('# The comet\nIt was **red** and *bright*, ~~not~~ ==ominous==, `rare`.')).toBe(
      '<h1>The comet</h1><p>It was <strong>red</strong> and <em>bright</em>, <del>not</del> <mark>ominous</mark>, <code>rare</code>.</p>'
    )
    expect(markdownToHtml('- one\n- [x] done\n- [ ] to do\n\n1. first\n2. second')).toBe(
      '<ul><li>one</li><li><input type="checkbox" disabled checked> done</li><li><input type="checkbox" disabled> to do</li></ul><ol><li>first</li><li>second</li></ol>'
    )
    expect(markdownToHtml('> a warning\n> twice\n\n---\n```\nlet x = 1 < 2\n```')).toBe('<blockquote><p>a warning<br>twice</p></blockquote><hr><pre><code>let x = 1 &lt; 2</code></pre>')
    expect(markdownToHtml('See [the map](https://example.com/map) and [[Calder|the capital]]')).toBe(
      '<p>See <a href="https://example.com/map" target="_blank" rel="noreferrer">the map</a> and <span class="wikilink">the capital</span></p>'
    )
  })

  it('lets no HTML or script links of its own through', () => {
    const html = markdownToHtml('<img src=x onerror=alert(1)> [x](javascript:alert(1)) "quoted"')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('href="javascript')
    expect(html).toContain('&lt;img')
    expect(markdownToHtml('[x](https://a.b/" onclick="y)')).not.toContain(' onclick="')
  })

  it('gives its first line as a title', () => {
    expect(firstLine('\n## The **Long** Night\nmore')).toBe('The Long Night')
  })
})
