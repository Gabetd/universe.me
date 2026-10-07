import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef } from 'react'
import type { MenuAction } from '../../../shared/api'
import { HISTORY_EVENT } from '../input'

interface Props {
  /** HTML. Plain text from older projects loads as a paragraph. */
  value: string
  onCommit(html: string): void
  placeholder?: string
  label: string
}

type Chain = ReturnType<Editor['chain']>

const FORMATS: { label: string; mark: string; run(chain: Chain): Chain; icon: React.ReactNode }[] = [
  { label: 'Bold', mark: 'bold', run: (c) => c.toggleBold(), icon: <b>B</b> },
  { label: 'Italic', mark: 'italic', run: (c) => c.toggleItalic(), icon: <i>I</i> },
  { label: 'Heading', mark: 'heading', run: (c) => c.toggleHeading({ level: 3 }), icon: 'H' },
  { label: 'Bullet list', mark: 'bulletList', run: (c) => c.toggleBulletList(), icon: '•' },
  { label: 'Quote', mark: 'blockquote', run: (c) => c.toggleBlockquote(), icon: '❝' }
]

/** Rich-text notes (bold, italic, headings, lists, quotes). Saves to the project when it loses focus. */
export function NotesEditor({ value, onCommit, placeholder = 'Lore, ideas, anything…', label }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const editor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder })],
    content: value,
    editorProps: { attributes: { class: 'notes-editor', 'aria-label': label, role: 'textbox', 'aria-multiline': 'true' } },
    onBlur: ({ editor: e }) => {
      const html = e.isEmpty ? '' : e.getHTML()
      if (html !== value) onCommit(html)
    }
  })

  // The notes keep their own undo history; claim Edit → Undo/Redo while focused.
  useEffect(() => {
    const el = root.current
    if (!el || !editor) return
    const onHistory = (e: Event) => {
      e.preventDefault()
      editor.commands[(e as CustomEvent<MenuAction>).detail]()
    }
    el.addEventListener(HISTORY_EVENT, onHistory)
    return () => el.removeEventListener(HISTORY_EVENT, onHistory)
  }, [editor])

  return (
    <div className="notes" ref={root}>
      <div className="notes-toolbar" role="toolbar" aria-label={`${label} formatting`}>
        {FORMATS.map((f) => (
          <button
            key={f.mark}
            type="button"
            title={f.label}
            aria-label={f.label}
            aria-pressed={editor?.isActive(f.mark) ?? false}
            // Keep focus in the editor so the selection survives the click.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor && f.run(editor.chain().focus()).run()}
          >
            {f.icon}
          </button>
        ))}
      </div>
      <EditorContent editor={editor} />
    </div>
  )
}
