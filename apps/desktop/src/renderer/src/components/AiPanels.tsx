import { useEffect, useState } from 'react'
import type { AiChange, ApiStatus } from '../../../shared/api'
import { applyReply, useUi } from '../store'

/**
 * AI clients in the app (PLAN.md §6.3): connecting them (the Connect AI
 * panel), what they change (a note for each change, undone in one click),
 * and, in review mode, their suggestions to accept or reject.
 */

const undoAi = () => applyReply(window.universe.undoAi())

/** The API's status, kept up to date, and a way to change it that shows the change at once. */
function useApiStatus(): [ApiStatus | undefined, (patch: { enabled?: boolean; review?: boolean }) => void] {
  const [status, setStatus] = useState<ApiStatus>()
  useEffect(() => {
    void window.universe.apiStatus().then(setStatus)
    return window.universe.onApi(setStatus)
  }, [])
  const set = (patch: { enabled?: boolean; review?: boolean }) => {
    setStatus((s) => s && { ...s, ...patch })
    void window.universe.setApi(patch).then(setStatus)
  }
  return [status, set]
}

/** A command to copy, in a box that selects it all. */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="field">
      <span className="field-label-row">
        {label}
        <button className="link small" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
      <textarea className="copy-field" readOnly rows={3} value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
    </div>
  )
}

/** The topbar button that opens the Connect AI panel, lit while AI clients can connect. */
export function ConnectAiButton() {
  const [status, set] = useApiStatus()
  const [open, setOpen] = useState(false)
  const on = !!status?.enabled && status.port !== null
  return (
    <div className="connect-ai">
      <button aria-expanded={open} onClick={() => setOpen(!open)} title={on ? `AI clients can connect on 127.0.0.1:${status!.port}` : 'Connect Claude or another AI client'}>
        <span className={`connect-dot${on ? ' on' : ''}`} aria-hidden /> Connect AI
      </button>
      {open && status && <ConnectPanel status={status} set={set} onClose={() => setOpen(false)} />}
    </div>
  )
}

function ConnectPanel({ status, set, onClose }: { status: ApiStatus; set(patch: { enabled?: boolean; review?: boolean }): void; onClose(): void }) {
  const [showToken, setShowToken] = useState(false)
  return (
    <section className="connect-panel" aria-label="Connect AI">
      <div className="inspector-kind">
        🤖 Connect AI
        <button className="link close" aria-label="Close connect AI" onClick={onClose}>
          ✕
        </button>
      </div>
      <p className="small muted">
        Let Claude Code (or any MCP client) read this universe and add to it, through a server on this computer only. Each change it makes shows here and can be undone in one click.
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={status.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Let AI connect
      </label>
      <p className="small" aria-label="Connection status">
        {!status.enabled ? 'Off: no client can connect.' : status.port !== null ? `Listening on 127.0.0.1:${status.port}.` : (status.error ?? 'Starting…')}
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={status.review} onChange={(e) => set({ review: e.target.checked })} /> Review AI changes before they apply
      </label>
      {status.connect && (
        <>
          <CopyField label="Add to Claude Code (to the app, while it’s open)" value={status.connect.http} />
          <CopyField label="Or run it as a stdio server (works with the app closed too)" value={status.connect.stdio} />
          <div className="field">
            <span className="field-label-row">
              Token
              <button className="link small" onClick={() => setShowToken(!showToken)}>
                {showToken ? 'Hide' : 'Show'}
              </button>
            </span>
            <code className="token">{showToken ? status.token : '•'.repeat(24)}</code>
            <span className="small muted">
              REST: http://127.0.0.1:{status.port}/v1 (described at /v1/openapi.json), with the header <code>Authorization: Bearer &lt;token&gt;</code>.
            </span>
          </div>
          <button className="link small" onClick={() => void window.universe.newApiToken()}>
            New token (clients with the old one stop working)
          </button>
        </>
      )}
    </section>
  )
}

/** In the topbar while the latest changes are an AI client's: takes them all back. */
export function UndoAiButton() {
  const count = useUi((s) => s.aiChanges)
  if (!count) return null
  return (
    <button onClick={() => void undoAi()} title="Undo every change the AI made since your last one">
      ↶ Undo AI ({count})
    </button>
  )
}

interface Note extends AiChange {
  key: number
}

/** A note for each change an AI client makes, for a few seconds (suggestions show in their own list). */
export function AiNotes() {
  const [notes, setNotes] = useState<Note[]>([])
  const canUndo = useUi((s) => s.aiChanges > 0)
  useEffect(() => {
    let key = 0
    return window.universe.onAiChange((change) => {
      const note = { ...change, key: key++ }
      setNotes((list) => [...list.slice(-3), note])
      setTimeout(() => setNotes((list) => list.filter((n) => n !== note)), 8000)
    })
  }, [])
  if (!notes.length) return null
  return (
    <div className="ai-notes" role="status" aria-label="AI changes">
      {notes.map((n) => (
        <div key={n.key} className="ai-note">
          <span>🤖 {n.summary}</span>
          {canUndo && (
            <button className="link small" onClick={() => void undoAi()}>
              Undo
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/** In review mode, what AI clients suggest, oldest first: each to accept (as the AI's change) or turn down. */
export function AiSuggestions() {
  const proposals = useUi((s) => s.proposals)
  if (!proposals.length) return null
  const acceptAll = async () => {
    for (const p of proposals) if (!(await applyReply(window.universe.acceptProposal(p.id)))) return
  }
  return (
    <section className="ai-suggestions" aria-label="AI suggestions">
      <div className="ai-suggestions-head">
        <b>🤖 {proposals.length === 1 ? 'A suggested change' : `${proposals.length} suggested changes`}</b>
        {proposals.length > 1 && (
          <button className="link small" onClick={() => void acceptAll()}>
            Accept all
          </button>
        )}
      </div>
      <ul>
        {proposals.map((p) => (
          <li key={p.id}>
            <span>{p.summary}</span>
            <span className="ai-suggestion-actions">
              <button className="primary small" onClick={() => void applyReply(window.universe.acceptProposal(p.id))}>
                Accept
              </button>
              <button className="small" onClick={() => void applyReply(window.universe.rejectProposal(p.id))}>
                Reject
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
