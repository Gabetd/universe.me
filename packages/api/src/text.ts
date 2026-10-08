/** Notes are stored as the rich-text editor's HTML; API clients read and write plain text (paragraphs, "- " lists). */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }

/** Block ends: two line breaks after each. */
const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol'])

/**
 * A note's HTML as plain text: paragraphs and list items on their own lines,
 * tags dropped. One pass over the tags, so its time follows the note's
 * length whatever is in it (a note can come from anyone: a shared project,
 * an AI client).
 */
export function htmlToText(html: string): string {
  let out = ''
  // Just inside a list item (only spaces since): its paragraph doesn't start a new block.
  let itemStart = false
  let itemParagraph = false
  for (let i = 0; i < html.length; ) {
    const open = html.indexOf('<', i)
    const close = open < 0 ? -1 : html.indexOf('>', open + 1)
    if (close < 0) {
      out += html.slice(i)
      break
    }
    const text = html.slice(i, open)
    // Spaces between a list item and its paragraph aren't text.
    if (!itemStart || text.trim()) out += text
    if (text.trim()) itemStart = false
    const [, slash, name] = /^(\/?)([a-z0-9]*)/i.exec(html.slice(open + 1, Math.min(close, open + 12)))!
    const tag = name!.toLowerCase()
    if (!slash && tag === 'li') out += '- '
    else if (!slash && tag === 'p' && itemStart) itemParagraph = true
    else if (!slash && tag === 'br') out += '\n'
    else if (slash && tag === 'li') out += '\n'
    else if (slash && tag === 'p' && itemParagraph) itemParagraph = false
    else if (slash && BLOCKS.has(tag)) out += '\n\n'
    itemStart = !slash && tag === 'li'
    i = close + 1
  }
  return out
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e]!)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Plain text as note HTML: a paragraph per block, "- " lines as a list, line breaks kept. */
export function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n')
      if (lines.every((l) => /^\s*[-*]\s/.test(l))) return `<ul>${lines.map((l) => `<li><p>${escape(l.replace(/^\s*[-*]\s/, ''))}</p></li>`).join('')}</ul>`
      return `<p>${lines.map(escape).join('<br>')}</p>`
    })
    .join('')
}
