import { useEffect, useMemo, useState } from 'react'
import { useUi } from '../store'
import { Modal, dialogStore } from './Modal'

/** Whether the dictionary is open (Edit → Dictionary…). */
export const useDictionaryDialog = dialogStore()

const close = () => useDictionaryDialog.getState().set(false)

/**
 * The words the user added to the spelling dictionary (right-click a word →
 * Add to the dictionary, or here), and taking them out again. The names in
 * the open universe count as words without being added.
 */
export function DictionaryDialog() {
  const open = useDictionaryDialog((s) => s.open)
  return open ? <Words /> : null
}

function Words() {
  const [words, setWords] = useState<string[] | null>(null)
  const [word, setWord] = useState('')
  useEffect(() => void window.universe.dictionaryWords().then(setWords), [])
  const add = () => {
    const w = word.trim()
    if (!w || /\s/.test(w)) return
    void window.universe.addWord(w).then(setWords)
    setWord('')
  }
  return (
    <Modal title="Dictionary" closeLabel="Close dictionary" className="versions-dialog" onClose={close}>
      <p className="muted small">
        Misspelled words are underlined as you type: right-click one for corrections, or to add it here. The names of everything in the open universe count as words already.
      </p>
      <div className="field-row">
        <input aria-label="New word" placeholder="A word to add" value={word} onChange={(e) => setWord(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button onClick={add} disabled={!word.trim() || /\s/.test(word.trim())}>
          Add
        </button>
      </div>
      {words && words.length === 0 && <p className="muted small">No words of your own yet.</p>}
      {words && words.length > 0 && (
        <ul className="chip-list dictionary-words" aria-label="Your words">
          {words.map((w) => (
            <li key={w}>
              {w}
              <button className="link" aria-label={`Remove ${w}`} onClick={() => void window.universe.removeWord(w).then(setWords)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

/** Tells the dictionary the names in the open universe as they change, so they aren't underlined. (A component of its own, so only it redraws when they do.) */
export function SpellingNames(): null {
  const nodes = useUi((s) => s.nodes)
  const regions = useUi((s) => s.regions)
  const timeline = useUi((s) => s.timeline)
  const names = useMemo(() => {
    const t = timeline
    return [
      ...nodes.map((n) => n.name),
      ...regions.map((r) => r.name),
      ...[t.characters, t.factions, t.structures, t.lifeforms, t.powers, t.themes, t.eras].flatMap((list: { name: string }[]) => list.map((r) => r.name)),
      ...[t.events, t.groups].flatMap((list: { title: string }[]) => list.map((r) => r.title))
    ].join('\n')
  }, [nodes, regions, timeline])
  useEffect(() => void window.universe.setSpellingNames(names.split('\n')), [names])
  return null
}
