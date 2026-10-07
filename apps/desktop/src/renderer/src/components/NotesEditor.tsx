import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'

/** The notes editor that has focus, so Edit → Undo can go to its own history instead of the project's. */
export let focusedNotesEditor: Editor | null = null

interface Props {
  /** HTML. Plain text from older projects loads as a paragraph. */
  value: string
  onCommit(html: string): void
  placeholder?: string
  label: string
}

/** Rich-text notes (bold, italic, headings, lists, quotes). Saves to the project when it loses focus. */
export function NotesEditor({ value, onCommit, placeholder = 'Lore, ideas, anything…', label }: Props) {
  const editor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder })],
    content: value,
    editorProps: { attributes: { class: 'notes-editor', 'aria-label': label, role: 'textbox', 'aria-multiline': 'true' } },
    onFocus: ({ editor: e }) => (focusedNotesEditor = e),
    onBlur: ({ editor: e }) => {
      if (focusedNotesEditor === e) focusedNotesEditor = null
      const html = e.isEmpty ? '' : e.getHTML()
      if (html !== value) onCommit(html)
    }
  })

  return (
    <div className="notes">
      <div className="notes-toolbar" role="toolbar" aria-label={`${label} formatting`}>
        <FormatButton editor={editor} label="Bold" mark="bold" run={(c) => c.toggleBold()}>
          <b>B</b>
        </FormatButton>
        <FormatButton editor={editor} label="Italic" mark="italic" run={(c) => c.toggleItalic()}>
          <i>I</i>
        </FormatButton>
        <FormatButton editor={editor} label="Heading" mark="heading" run={(c) => c.toggleHeading({ level: 3 })}>
          H
        </FormatButton>
        <FormatButton editor={editor} label="Bullet list" mark="bulletList" run={(c) => c.toggleBulletList()}>
          •
        </FormatButton>
        <FormatButton editor={editor} label="Quote" mark="blockquote" run={(c) => c.toggleBlockquote()}>
          ❝
        </FormatButton>
      </div>
      <EditorContent editor={editor} />
    </div>
  )
}

type Chain = ReturnType<Editor['chain']>

function FormatButton(props: { editor: Editor | null; label: string; mark: string; run(chain: Chain): Chain; children: React.ReactNode }) {
  const { editor } = props
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={editor?.isActive(props.mark) ?? false}
      // Keep focus in the editor so the selection survives the click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => editor && props.run(editor.chain().focus()).run()}
    >
      {props.children}
    </button>
  )
}
