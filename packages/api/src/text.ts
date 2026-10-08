/** Notes are stored as the rich-text editor's HTML; API clients read and write plain text (paragraphs, "- " lists). */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }

/** A note's HTML as plain text: paragraphs and list items on their own lines, tags dropped. */
export function htmlToText(html: string): string {
  return html
    // A list item's paragraph doesn't start a new block.
    .replace(/<li[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/gi, '<li>$1')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(p|h[1-6]|blockquote|ul|ol)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
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
