/**
 * A text card's Markdown as HTML, for showing it (Obsidian's cards are
 * Markdown): headings, paragraphs, bold, italic, strikethrough, highlights,
 * inline code and code blocks, bulleted, numbered and task lists, quotes,
 * rules and links. Everything is escaped first, so no HTML of the card's
 * own gets through, and links go only to web pages (opened in the browser).
 */

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Inline marks, on text already escaped. */
function inline(text: string): string {
  const codes: string[] = []
  // Code first, kept out of the other marks.
  let out = text.replace(/`([^`]+)`/g, (_, code: string) => `\uE000${codes.push(code) - 1}\uE000`)
  out = out
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, name: string, label?: string) => `<span class="wikilink">${label ?? name}</span>`)
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a?: string, b?: string) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)|(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, (_, p1?: string, a?: string, p2?: string, b?: string) => `${p1 ?? p2 ?? ''}<em>${a ?? b}</em>`)
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
  return out.replace(/\uE000(\d+)\uE000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`)
}

export function markdownToHtml(markdown: string): string {
  const lines = escape(markdown.replace(/\r\n?/g, '\n')).split('\n')
  const html: string[] = []
  let paragraph: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null
  let quote: string[] = []
  const flush = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`)
    paragraph = []
    if (list) html.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`)
    list = null
    if (quote.length) html.push(`<blockquote>${markdownToHtml(unescape(quote.join('\n')))}</blockquote>`)
    quote = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^```/.test(line)
    if (fence) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i]!)
      html.push(`<pre><code>${code.join('\n')}</code></pre>`)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const quoted = /^&gt;\s?(.*)$/.exec(line)
    if (quoted) {
      if (!quote.length) flush()
      quote.push(quoted[1]!)
    } else if (heading) {
      flush()
      html.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`)
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      html.push('<hr>')
    } else if (bullet || numbered) {
      const tag = bullet ? 'ul' : 'ol'
      if (paragraph.length || quote.length || (list && list.tag !== tag)) flush()
      list ??= { tag, items: [] }
      const task = bullet?.[1]
      const text = inline((bullet ? bullet[2] : numbered![1])!)
      list.items.push(task === undefined ? text : `<input type="checkbox" disabled${task === ' ' ? '' : ' checked'}> ${text}`)
    } else if (!line.trim()) flush()
    else {
      if (list || quote.length) flush()
      paragraph.push(line)
    }
  }
  flush()
  return html.join('')
}

/** Undoes `escape`, for a quote's lines, which are escaped again as they're rendered. */
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
