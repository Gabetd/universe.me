import { SEVERITY_LABELS, ecosystemWarnings, factionWarnings, structureWarnings, timelineWarnings, type Finding, type FindingStatus } from '@universe/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { menuRef, nameOf, openElement, parseMenuRef, type ElementKind } from '../contextMenu'
import { useOwnRecords, useUi } from '../store'
import { useSteadyScroll } from '../useSteadyScroll'
import { useEditor } from './editorStore'
import { useConditionCurves } from './useStructures'

/**
 * A world's warnings (PLAN.md §6.5): what Claude found inconsistent reading
 * it as a whole (each about some of the world's elements, open until resolved
 * or dismissed), and the app's own checks. Claude is asked from here: the
 * request is copied, to paste into Claude wherever it's connected.
 */

/** Shows what a warning is about: in the inspector, or the world view that has it (species, powers). */
function show(ref: { kind: string; id: string }) {
  if (ref.kind === 'species' || ref.kind === 'power') return useEditor.getState().set({ view: ref.kind === 'power' ? 'powers' : 'species' })
  const element = parseMenuRef(menuRef(ref.kind as ElementKind, ref.id))
  if (element) openElement(element)
}

/** What a world's open findings and the app's checks come to, for the tab's count. */
export function useWarningCount(worldId: string): number {
  return useOwnRecords('findings', worldId).filter((f) => f.status === 'open').length
}

export function WarningsView({ worldId }: { worldId: string }) {
  const name = useUi((s) => s.nodes.find((n) => n.id === worldId)?.name ?? 'this world')
  const own = useOwnRecords('findings', worldId)
  const findings = useMemo(() => [...own].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [own])
  const open = findings.filter((f) => f.status === 'open')
  const closed = findings.filter((f) => f.status !== 'open')
  const checks = useAppChecks(worldId)
  const content = useRef<HTMLDivElement>(null)
  useSteadyScroll(content, worldId)

  return (
    <div className="warnings-view">
      <div className="warnings-inner" ref={content}>
        <section className="warnings-ask" aria-label="Ask Claude">
          <h3>What doesn’t fit</h3>
          <p className="muted">
            Claude, connected to Universe (Connect AI), can read {name} as a whole and flag what contradicts itself: people in two places at once, powers used in an age that doesn’t allow them, notes at odds
            with the history. What it finds shows here, with a mark on what it’s about.
          </p>
          <CopyRequest worldId={worldId} name={name} />
        </section>

        <section aria-label="From Claude">
          <h4>
            From Claude <span className="badge">{open.length}</span>
          </h4>
          {open.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
          {open.length === 0 && <p className="muted small">Nothing open. Ask Claude to check, or wait for what it finds while it works on this world.</p>}
          {closed.length > 0 && (
            <details>
              <summary className="muted small">Resolved and dismissed ({closed.length})</summary>
              {closed.map((f) => (
                <FindingCard key={f.id} finding={f} />
              ))}
            </details>
          )}
        </section>

        <section aria-label="The app’s checks">
          <h4>
            The app’s checks <span className="badge">{checks.length}</span>
          </h4>
          {checks.length ? (
            <ul className="warning-list">
              {checks.map((w, i) => (
                <li key={i}>
                  <button className="link" onClick={() => w.refs[0] && show(w.refs[0])}>
                    {w.message}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nothing wrong in the history, the structures, the food web or the factions.</p>
          )}
        </section>
      </div>
    </div>
  )
}

/** The app's own checks on a world: its history, its structures, its food web and its factions. */
function useAppChecks(worldId: string) {
  const events = useOwnRecords('events', worldId)
  const links = useOwnRecords('links', worldId)
  const changes = useOwnRecords('changes', worldId)
  const species = useOwnRecords('lifeforms', worldId)
  const ecolinks = useOwnRecords('ecolinks', worldId)
  const factions = useOwnRecords('factions', worldId)
  const memberships = useOwnRecords('memberships', worldId)
  const holdings = useOwnRecords('holdings', worldId)
  const relationships = useOwnRecords('relationships', worldId)
  const characters = useOwnRecords('characters', worldId)
  const regions = useUi((s) => s.regions)
  const { world, curves } = useConditionCurves(worldId)
  return useMemo(
    () => [
      ...timelineWarnings({ events, links, changes }, regions),
      ...structureWarnings(world, curves),
      ...ecosystemWarnings(species, ecolinks).map((w) => ({ message: w.message, refs: w.ids.map((id) => ({ kind: 'species' as const, id })) })),
      ...factionWarnings({ factions, memberships, holdings, relationships, characters, events }, regions)
    ],
    [events, links, changes, species, ecolinks, factions, memberships, holdings, relationships, characters, regions, world, curves]
  )
}

/** Copies a request to paste into Claude (on this computer, or the phone): check this world, and report what's wrong. */
function CopyRequest({ worldId, name }: { worldId: string; name: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 4000)
    return () => clearTimeout(t)
  }, [copied])
  const request = `Check my world “${name}” in Universe for inconsistencies: use the review_consistency prompt with worldId ${worldId} (or read the world with the Universe tools), and report each problem with report_inconsistency.`
  return (
    <div className="field-row">
      <button className="primary" onClick={() => void navigator.clipboard.writeText(request).then(() => setCopied(true))}>
        Copy a request for Claude
      </button>
      <span className="muted small" role="status" aria-label="Request for Claude">
        {copied ? 'Copied: paste it into Claude.' : ''}
      </span>
    </div>
  )
}

const STATUS_TEXT: Record<Exclude<FindingStatus, 'open'>, string> = { resolved: 'Resolved', dismissed: 'Not a problem' }

function FindingCard({ finding: f }: { finding: Finding }) {
  const execute = useUi((s) => s.execute)
  // Subscribed for the names of what it's about: a rename shows here at once.
  useUi((s) => s.timeline)
  const setStatus = (status: FindingStatus) => void execute({ type: 'finding.update', payload: { id: f.id, patch: { status } } })
  return (
    <article className={`finding ${f.severity} ${f.status}`} aria-label={f.title}>
      <header>
        <span className="finding-severity">{SEVERITY_LABELS[f.severity]}</span>
        <b>{f.title}</b>
      </header>
      {f.explanation && <p>{f.explanation}</p>}
      {f.suggestion && (
        <p className="muted">
          <b>Suggested fix:</b> {f.suggestion}
        </p>
      )}
      {f.refs.length > 0 && (
        <div className="finding-about" role="group" aria-label="About">
          {f.refs.map((r) => {
            const label = nameOf(r)
            return (
              <button key={`${r.kind}:${r.id}`} className="chip" disabled={label === undefined} data-menu={label === undefined ? undefined : menuRef(r.kind, r.id)} onClick={() => show(r)}>
                {label ?? 'deleted'}
              </button>
            )
          })}
        </div>
      )}
      <footer className="field-row">
        {f.status === 'open' ? (
          <>
            <button onClick={() => setStatus('resolved')}>Resolved</button>
            <button onClick={() => setStatus('dismissed')} title="Not a problem: Claude won’t raise it again">
              Not a problem
            </button>
          </>
        ) : (
          <>
            <span className="muted small">
              {STATUS_TEXT[f.status]}
              {f.note && `: ${f.note}`}
            </span>
            <button className="link accent" onClick={() => setStatus('open')}>
              Reopen
            </button>
          </>
        )}
        {f.reporter && <span className="muted small finding-by">from {f.reporter}</span>}
      </footer>
    </article>
  )
}
