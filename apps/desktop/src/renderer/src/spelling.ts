import type { MenuItem } from './contextMenu'

/**
 * Right-clicking text being typed: the word under the pointer, corrections
 * for it if it's misspelled (from the app's dictionary, main/dictionary.ts),
 * adding it to the dictionary, and cut, copy, paste and select all. Works in
 * text fields, text areas and the notes editor.
 */

type Field = HTMLInputElement | HTMLTextAreaElement

/** A word in some text being edited, and how to put another in its place. */
interface WordAt {
  word: string
  /** Selects the word, so what's typed next (or inserted) replaces it. */
  select(): void
}

const WORD_CHAR = /[\p{L}\p{M}'’]/u

/** The word around `offset` in `text`: its start and end, or undefined between words. */
function wordIn(text: string, offset: number): [number, number] | undefined {
  let start = offset
  let end = offset
  while (start > 0 && WORD_CHAR.test(text[start - 1]!)) start--
  while (end < text.length && WORD_CHAR.test(text[end]!)) end++
  // Not the apostrophes around it ('quoted').
  while (start < end && /['’]/.test(text[start]!)) start++
  while (end > start && /['’]/.test(text[end - 1]!)) end--
  return end > start ? [start, end] : undefined
}

const isTextField = (el: Element): el is Field =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && ['text', 'search', ''].includes(el.type))

/** The word under the point (x, y) in the field or editor `target` is in. */
function wordAt(target: Element, x: number, y: number): WordAt | undefined {
  const caret = document.caretPositionFromPoint(x, y)
  if (isTextField(target)) {
    // Over the field's text the caret is at its offset; otherwise, where its caret already is.
    const offset = caret?.offsetNode === target ? caret.offset : (target.selectionStart ?? 0)
    const span = wordIn(target.value, offset)
    if (!span) return undefined
    return { word: target.value.slice(...span), select: () => (target.focus(), target.setSelectionRange(...span)) }
  }
  const node = caret?.offsetNode
  if (!node || node.nodeType !== Node.TEXT_NODE) return undefined
  const span = wordIn(node.textContent ?? '', caret.offset)
  if (!span) return undefined
  return {
    word: (node.textContent ?? '').slice(...span),
    select: () => {
      const range = document.createRange()
      range.setStart(node, span[0])
      range.setEnd(node, span[1])
      ;(target as HTMLElement).focus()
      const selection = getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
  }
}

/** Puts `text` where the selection is, as typing it would (so it's one step of the field's or editor's undo, and the page hears it). */
const insert = (text: string) => document.execCommand('insertText', false, text)

/** The element being edited that `target` is in, if it's text being edited. */
export function editableAt(target: Element): HTMLElement | undefined {
  const field = target.closest('input, textarea')
  if (field) return isTextField(field) ? field : undefined
  return target.closest<HTMLElement>('[contenteditable="true"]') ?? undefined
}

/** The menu for a right-click at (x, y) in `editable`: the word's corrections and adding it to the dictionary, then editing. */
export async function textMenu(editable: HTMLElement, x: number, y: number): Promise<{ title?: string; items: MenuItem[] }> {
  const found = wordAt(editable, x, y)
  const { misspelled, suggestions } = found ? await window.universe.spellWord(found.word) : { misspelled: false, suggestions: [] }
  const selected = () => {
    if (isTextField(editable)) return editable.selectionStart !== editable.selectionEnd
    return !!getSelection()?.toString()
  }
  const keep = isTextField(editable) ? ([editable.selectionStart, editable.selectionEnd] as const) : undefined
  /** Back to the field, with what was selected when the menu opened. */
  const refocus = () => {
    editable.focus()
    if (keep && isTextField(editable)) editable.setSelectionRange(keep[0], keep[1])
  }
  const spelling: MenuItem[] = misspelled
    ? [
        ...(suggestions.length
          ? suggestions.map((s): MenuItem => ({ label: s, run: () => (found!.select(), insert(s)) }))
          : [{ label: 'No suggestions', run: () => {} }]),
        { label: `Add “${found!.word}” to the dictionary`, run: () => void window.universe.addWord(found!.word).then(refresh) },
        'separator'
      ]
    : []
  const editing: MenuItem[] = [
    ...(selected() ? [{ label: 'Cut', run: () => (refocus(), document.execCommand('cut')) }, { label: 'Copy', run: () => (refocus(), document.execCommand('copy')) }] : []),
    { label: 'Paste', run: () => (refocus(), void window.universe.paste()) },
    { label: 'Select all', run: () => (editable.focus(), document.execCommand('selectAll')) }
  ]
  return { title: misspelled ? `Spelling · ${found!.word}` : undefined, items: [...spelling, ...editing] }
}

/** Asks the page's spellchecking to look again, so a word just added stops being underlined. */
function refresh(): void {
  const el = document.activeElement
  if (el instanceof HTMLElement) {
    el.spellcheck = false
    el.spellcheck = true
  }
}
