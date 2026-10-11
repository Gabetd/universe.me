import { defaultOptions, type ContributionKind, type PluginOption } from '@universe/plugins/manifest'
import { useEffect, useState } from 'react'
import type { PluginInfo } from '../../../shared/api'
import { contributions, usePlugins, type Naming } from '../pluginStore'
import { undo, useUi } from '../store'
import { Modal, dialogStore } from './Modal'

/**
 * Plugins in the app (PLAN.md §9, M16): the plugin manager (Tools →
 * Plugins…), running a generator or exporter with its options (there, or
 * from a world's inspector), what a run did, and picking from the names a
 * name generator made.
 */

/** Whether the plugin manager is open. */
export const usePluginsDialog = dialogStore()

const close = () => usePluginsDialog.getState().set(false)

type Contribution = NonNullable<PluginInfo['manifest']>['generators' | 'exporters'][number]

export function PluginsDialog() {
  const open = usePluginsDialog((s) => s.open)
  return open ? <Manager /> : null
}

function Manager() {
  const list = usePlugins((s) => s.list)
  const [error, setError] = useState<string>()
  useEffect(() => void usePlugins.getState().refresh(), [])
  const act = async (reply: Promise<{ ok: true; value: PluginInfo[] | null } | { ok: false; error: string }>) => {
    const r = await reply
    if (!r.ok) setError(r.error)
    else {
      setError(undefined)
      if (r.value) usePlugins.getState().set(r.value)
    }
  }
  return (
    <Modal title="Plugins" closeLabel="Close plugins" className="plugins-dialog" onClose={close}>
      <p className="muted small">
        Plugins add generators (villages, histories, anything made through the app’s operations, undone in one step), exporters (a world out to a wiki, a map image, a game) and name generators. Each runs sandboxed: no network,
        and no files but the ones you pick.
      </p>
      <div className="field-row">
        <button onClick={() => void act(window.universe.newPlugin())}>+ New plugin from the template</button>
        <button onClick={() => void act(window.universe.addPlugin())}>Add a plugin folder…</button>
      </div>
      {error && <p className="error small">{error}</p>}
      <RunNote />
      {list.length === 0 ? (
        <p className="muted small">No plugins yet. Start one from the template (a working example, with how to write one in its README), or add a plugin’s folder.</p>
      ) : (
        <ul className="plugin-list" aria-label="Installed plugins">
          {list.map((p) => (
            <PluginEntry key={p.path} plugin={p} onReply={act} />
          ))}
        </ul>
      )}
    </Modal>
  )
}

function PluginEntry({ plugin, onReply }: { plugin: PluginInfo; onReply(reply: Promise<{ ok: true; value: PluginInfo[] | null } | { ok: false; error: string }>): Promise<void> }) {
  const m = plugin.manifest
  const name = m?.name ?? plugin.id
  const worldId = useSelectedWorld()
  return (
    <li className="plugin-entry" aria-label={name}>
      <div className="plugin-head">
        <label className="check">
          <input type="checkbox" checked={plugin.enabled} disabled={!!plugin.error} aria-label={`${name} on`} onChange={(e) => void window.universe.setPluginEnabled(plugin.id, e.target.checked).then(usePlugins.getState().set)} />
          <b>{name}</b>
        </label>
        {m && <span className="muted small">{m.version}{m.author ? ` · ${m.author}` : ''}</span>}
        <span className="plugin-buttons">
          <button className="link small" onClick={() => void window.universe.showPlugin(plugin.id)}>
            Show folder
          </button>
          <button className="link small danger" onClick={() => void onReply(window.universe.removePlugin(plugin.id))}>
            {plugin.linked ? 'Remove' : 'Remove (to the bin)'}
          </button>
        </span>
      </div>
      {m?.description && <p className="muted small">{m.description}</p>}
      {plugin.error && <p className="error small">{plugin.error}</p>}
      {m && plugin.enabled && !plugin.error && (
        <>
          {(['generators', 'exporters'] as const).map((kind) =>
            m[kind].map((c) => <PluginRunner key={`${kind}:${c.id}`} plugin={plugin} kind={kind} contribution={c} worldId={c.on === 'world' ? worldId : undefined} />)
          )}
          {m.names.length > 0 && <p className="muted small">Names: {m.names.map((n) => n.title).join(', ')} (in the right-click menus of what they name).</p>}
        </>
      )}
      {plugin.log.length > 0 && (
        <details className="plugin-log">
          <summary className="small">Its last run’s log ({plugin.log.length})</summary>
          <pre>{plugin.log.join('\n')}</pre>
        </details>
      )}
    </li>
  )
}

/** The selected world surface, if one is: what a world's generators and exporters run on. */
function useSelectedWorld(): string | undefined {
  return useUi((s) => {
    const node = s.nodes.find((n) => n.id === s.selectedId)
    return node?.kind === 'world' ? node.id : undefined
  })
}

/** One generator or exporter: what it does, the options it asks for, and running it. */
export function PluginRunner({ plugin, kind, contribution: c, worldId }: { plugin: PluginInfo; kind: Exclude<ContributionKind, 'names'>; contribution: Contribution; worldId: string | undefined }) {
  const [values, setValues] = useState(() => defaultOptions(c.options))
  const running = usePlugins((s) => s.running)
  const needsWorld = c.on === 'world' && !worldId
  const title = `${plugin.manifest?.name ?? plugin.id}: ${c.title}`
  return (
    <div className="plugin-runner" role="group" aria-label={c.title}>
      <div className="plugin-head">
        <span>
          {kind === 'generators' ? '✨' : '📤'} <b>{c.title}</b>
        </span>
        <button
          disabled={!!running || needsWorld}
          title={needsWorld ? 'Select a world surface to run it on' : undefined}
          onClick={() => void usePlugins.getState().run({ pluginId: plugin.id, kind, id: c.id, worldId, options: values }, title)}
        >
          {kind === 'generators' ? 'Run' : 'Export…'}
        </button>
      </div>
      {c.description && <p className="muted small">{c.description}</p>}
      {needsWorld && <p className="muted small">Select a world surface to run it on.</p>}
      {c.options.length > 0 && <OptionFields options={c.options} values={values} onChange={(id, v) => setValues((was) => ({ ...was, [id]: v }))} />}
    </div>
  )
}

/** A contribution's options as fields. */
function OptionFields({ options, values, onChange }: { options: readonly PluginOption[]; values: Record<string, unknown>; onChange(id: string, value: unknown): void }) {
  return (
    <div className="plugin-options">
      {options.map((o) => (
        <label key={o.id} className={o.type === 'flag' ? 'check' : 'field'} title={o.description}>
          {o.type === 'flag' ? (
            <>
              <input type="checkbox" checked={!!values[o.id]} onChange={(e) => onChange(o.id, e.target.checked)} /> {o.label}
            </>
          ) : (
            <>
              <span>{o.label}</span>
              {o.type === 'choice' ? (
                <select value={String(values[o.id])} onChange={(e) => onChange(o.id, e.target.value)}>
                  {o.choices.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              ) : o.type === 'number' ? (
                <input type="number" value={Number(values[o.id])} min={o.min} max={o.max} step={o.step} onChange={(e) => onChange(o.id, e.target.valueAsNumber)} />
              ) : (
                <input value={String(values[o.id])} onChange={(e) => onChange(o.id, e.target.value)} />
              )}
            </>
          )}
        </label>
      ))}
    </div>
  )
}

/** A world's generators and exporters from the plugins turned on, in its inspector. */
export function WorldPlugins({ worldId }: { worldId: string }) {
  const list = usePlugins((s) => s.list)
  const found = [...contributions(list, 'generators').map((x) => ({ ...x, kind: 'generators' as const })), ...contributions(list, 'exporters').map((x) => ({ ...x, kind: 'exporters' as const }))].filter((x) => x.contribution.on === 'world')
  if (!found.length) return null
  return (
    <section className="inspector-section" aria-label="Plugins">
      <h3>Plugins</h3>
      {found.map(({ plugin, contribution, kind }) => (
        <PluginRunner key={`${plugin.id}:${kind}:${contribution.id}`} plugin={plugin} kind={kind} contribution={contribution} worldId={worldId} />
      ))}
    </section>
  )
}

/** How a plugin run went, over the workspace (in the plugin manager while it's open). */
export function PluginNote() {
  const managing = usePluginsDialog((s) => s.open)
  return managing ? null : (
    <div className="ai-notes">
      <RunNote />
    </div>
  )
}

/** What's running, and how the last run went: what it changed (with undo), saved or said, or why it failed. */
function RunNote() {
  const running = usePlugins((s) => s.running)
  const note = usePlugins((s) => s.note)
  if (!running && !note) return null
  return (
    <div role="status" aria-label="Plugin run">
      <div className="ai-note">
        {running ? (
          <span>🧩 {running}: running…</span>
        ) : note?.error ? (
          <span className="error">🧩 {note.error}</span>
        ) : (
          <span>
            🧩 {note!.result!.summary}
            {note!.result!.saved && (note!.result!.saved.length ? ` · saved ${note!.result!.saved.length === 1 ? note!.result!.saved[0] : `${note!.result!.saved.length} files`}` : ' · not saved')}
          </span>
        )}
        {!running && note?.result && note.result.changes > 0 && (
          <button className="link small" onClick={() => void undo().then(() => usePlugins.getState().dismiss())}>
            Undo
          </button>
        )}
        {!running && (
          <button className="link small" aria-label="Dismiss" onClick={() => usePlugins.getState().dismiss()}>
            ✕
          </button>
        )}
      </div>
    </div>
  )
}

/** The rename each kind of thing takes: its update command, and its name's field. */
const RENAME: Partial<Record<Naming['ref']['kind'], [type: string, field: string]>> = {
  node: ['node.update', 'name'],
  region: ['region.update', 'name'],
  structure: ['structure.update', 'name'],
  character: ['character.update', 'name'],
  faction: ['faction.update', 'name'],
  species: ['species.update', 'name'],
  event: ['event.update', 'title']
}

/** The names a name generator made for one thing: pick one to give it (undoable like any rename). */
export function NamePicker() {
  const naming = usePlugins((s) => s.naming)
  if (!naming) return null
  const done = () => usePlugins.getState().name(null)
  const give = (name: string) => {
    const [type, field] = RENAME[naming.ref.kind]!
    void useUi.getState().execute({ type, payload: { id: naming.ref.id, patch: { [field]: name } } } as Parameters<ReturnType<typeof useUi.getState>['execute']>[0])
    done()
  }
  return (
    <Modal title={naming.title} closeLabel="Close names" className="versions-dialog" onClose={done}>
      <ul className="plain-list name-choices" aria-label="Names">
        {naming.names.map((n) => (
          <li key={n}>
            <button className="link" onClick={() => give(n)}>
              {n}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}

/** Runs a name generator for one thing and offers its names. */
export async function nameFrom(ref: Naming['ref'], plugin: PluginInfo, id: string, title: string, forKind: NonNullable<Parameters<typeof window.universe.runPlugin>[0]['naming']>['for']) {
  const contribution = plugin.manifest?.names.find((n) => n.id === id)
  const worldId = useUi.getState().nodes.find((n) => n.id === useUi.getState().selectedId && n.kind === 'world')?.id
  const result = await usePlugins
    .getState()
    .run({ pluginId: plugin.id, kind: 'names', id, worldId, options: contribution ? defaultOptions(contribution.options) : {}, naming: { for: forKind, count: 8 } }, title)
  if (result?.names?.length) {
    usePlugins.getState().dismiss()
    usePlugins.getState().name({ ref, title, names: result.names })
  }
}
