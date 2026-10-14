import { LANGUAGE_PRESETS, NAMED_KINDS, NAMED_KIND_LABELS, languageUseOf, nameIn, speakCommands, type Language, type NamedKind, type SpatialNode } from '@universe/core'
import { useMemo, useState } from 'react'
import { asCommand, updater, useUi } from '../store'
import { languageNow, useLanguageAt } from '../languages'
import { DeleteButton, NotesField, NumberInput, PanelHeader, TextField } from './fields'

/**
 * Languages in the inspector (core languages.ts): what's spoken at a node
 * (and what's under it) or in a region, chosen from the project's languages
 * or started from a preset, and a language's own panel: its sounds, its
 * naming rules and names it gives, to hear how it sounds.
 */

/** Sounds as they're typed: letters or groups of them, apart by spaces or commas. */
const soundsOf = (text: string) => text.split(/[\s,]+/).filter(Boolean)
const soundsText = (sounds: readonly string[]) => sounds.join(' ')

/** A few names a language gives a kind of thing, to show how it sounds. */
const samples = (language: Language, kind: NamedKind, count = 3) => Array.from({ length: count }, (_, i) => nameIn(language, kind, `sample-${i}`, kind === 'faction' ? 'Guild' : ''))

/** What a place speaks: its own language, or (none chosen) what's spoken around it. */
function LanguageChoice({ ownerId, regionId, label }: { ownerId: string; regionId: string | null; label: string }) {
  const languages = useUi((s) => s.timeline.languages)
  const uses = useUi((s) => s.timeline.languageUses)
  const nodes = useUi((s) => s.nodes)
  const own = languageUseOf(uses, ownerId, regionId)
  // What's spoken here without its own: the world's for a region, else what the node is under.
  const around = useMemo(() => {
    const parent = nodes.find((n) => n.id === ownerId)?.parentId
    const place = regionId ? { nodeId: ownerId } : parent ? { nodeId: parent } : undefined
    return place && languageNow(place, { languages, uses: uses.filter((u) => u.id !== own?.id), nodes })
  }, [languages, uses, nodes, ownerId, regionId, own?.id])
  const speak = (languageId: string | null) => {
    const command = asCommand(speakCommands(uses, ownerId, regionId, languageId))
    if (command) void useUi.getState().execute(command)
  }
  return (
    <label className="field">
      <span>{label}</span>
      <select aria-label={label} value={own?.languageId ?? ''} onChange={(e) => speak(e.target.value || null)}>
        <option value="">{around ? `As around it (${around.name})` : 'None (names as they’re made)'}</option>
        {languages.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  )
}

/** The project's languages to open, and a new one from a preset, spoken here at once. */
function LanguageLibrary({ ownerId }: { ownerId: string }) {
  const languages = useUi((s) => s.timeline.languages)
  const rootId = useUi((s) => s.nodes.find((n) => n.parentId === null)?.id)
  const [preset, setPreset] = useState(Object.keys(LANGUAGE_PRESETS)[0]!)
  const select = useUi.getState().selectTimeline
  const startNew = async () => {
    if (!rootId) return
    const { execute, timeline } = useUi.getState()
    const state = await execute({ type: 'language.create', payload: { ownerId: rootId, preset } })
    const id = state?.focus?.id
    if (!id) return
    const speak = asCommand(speakCommands(timeline.languageUses, ownerId, null, id))
    if (speak) await execute(speak)
    select({ kind: 'language', ids: [id] })
  }
  return (
    <>
      {languages.length > 0 && (
        <div className="theme-library" aria-label="Language library">
          {languages.map((l) => (
            <button key={l.id} className="link" onClick={() => select({ kind: 'language', ids: [l.id] })} title={`Edit ${l.name}`}>
              {l.name}
            </button>
          ))}
        </div>
      )}
      <div className="field-row">
        <select aria-label="Preset for a new language" value={preset} onChange={(e) => setPreset(e.target.value)}>
          {Object.keys(LANGUAGE_PRESETS).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button onClick={() => void startNew()}>New language spoken here</button>
      </div>
    </>
  )
}

/** In any node's inspector: the language spoken there and under it, how it names things, and the library. */
export function NodeLanguage({ node }: { node: SpatialNode }) {
  const language = useLanguageAt(node.id)
  return (
    <section className="inspector-section" aria-label="Language">
      <h3>Language</h3>
      <p className="muted small">
        What’s spoken here and in all it holds, unless a place in it speaks its own: rivers and lakes are named in it, and new {node.kind === 'world' ? 'species and factions' : 'planets, moons and stars'}.
      </p>
      <LanguageChoice ownerId={node.id} regionId={null} label="Spoken here" />
      {language && (
        <p className="small" aria-label="Names here">
          {samples(language, node.kind === 'world' ? 'river' : 'planet').join(' · ')}
        </p>
      )}
      <LanguageLibrary ownerId={node.id} />
    </section>
  )
}

/** In a region's inspector: the language spoken in it (its rivers and lakes are named in it). */
export function RegionLanguage({ worldId, regionId }: { worldId: string; regionId: string }) {
  return <LanguageChoice ownerId={worldId} regionId={regionId} label="Language spoken here" />
}

/** A language: its name, sounds, word length, naming rules (with names it gives) and notes. */
export function LanguagePanel({ language }: { language: Language }) {
  const update = updater('language', language.id)
  const uses = useUi((s) => s.timeline.languageUses.filter((u) => u.languageId === language.id).length)
  return (
    <section className="inspector-section" aria-label="Language">
      <PanelHeader icon="🗣" label="Language" onClose={() => useUi.getState().selectTimeline(null)} />
      <TextField label="Language name" value={language.name} required onCommit={(name) => update({ name })} />
      <p className="muted small">{uses ? `Spoken in ${uses} place${uses === 1 ? '' : 's'}.` : 'Not spoken anywhere yet: choose it in a world’s, a planet’s or a region’s Language.'}</p>
      <h4 className="muted small">Sounds</h4>
      <TextField label="Consonants" value={soundsText(language.consonants)} hint="Letters or groups (th, sh, qu), apart by spaces" onCommit={(v) => soundsOf(v).length && update({ consonants: soundsOf(v) })} />
      <TextField label="Vowels" value={soundsText(language.vowels)} hint="Letters or groups (ae, ou), apart by spaces" onCommit={(v) => soundsOf(v).length && update({ vowels: soundsOf(v) })} />
      <TextField
        label="Syllables"
        value={soundsText(language.syllables)}
        hint="Shapes a syllable takes: C a consonant, V a vowel (CV CVC V)"
        onCommit={(v) => {
          const shapes = soundsOf(v.toUpperCase()).filter((s) => /^[CV]{1,6}$/.test(s))
          if (shapes.length) update({ syllables: shapes })
        }}
      />
      <label className="field">
        <span>Syllables a word, from and to</span>
        <div className="field-row">
          <NumberInput value={language.minSyllables} min={1} max={5} integer onCommit={(minSyllables) => update({ minSyllables, maxSyllables: Math.max(minSyllables, language.maxSyllables) })} />
          <NumberInput value={language.maxSyllables} min={1} max={6} integer onCommit={(maxSyllables) => update({ maxSyllables, minSyllables: Math.min(maxSyllables, language.minSyllables) })} />
        </div>
      </label>
      <TextField label="Endings" value={soundsText(language.endings)} hint="Endings words often take (ia, or), apart by spaces" onCommit={(v) => update({ endings: soundsOf(v) })} />
      <h4 className="muted small">Naming rules</h4>
      <p className="muted small">How each kind of thing is called: {'{name}'} where the word goes ({'{kind}'} for a faction’s kind).</p>
      {NAMED_KINDS.map((kind) => (
        <div key={kind} className="language-rule">
          <TextField
            label={NAMED_KIND_LABELS[kind]}
            value={language.rules[kind]}
            hint="A pattern with {name}"
            onCommit={(rule) => rule.includes('{name}') && update({ rules: { ...language.rules, [kind]: rule } })}
          />
          <p className="muted small" aria-label={`${NAMED_KIND_LABELS[kind]} named`}>
            {samples(language, kind).join(' · ')}
          </p>
        </div>
      ))}
      <NotesField label="Language notes" value={language.notes} onCommit={(notes) => update({ notes })} />
      <DeleteButton kind="language" ids={[language.id]}>
        Delete language
      </DeleteButton>
    </section>
  )
}
