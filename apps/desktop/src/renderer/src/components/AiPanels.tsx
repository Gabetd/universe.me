import { useEffect, useRef, useState } from 'react'
import type { AiChange, ApiSettingsPatch, ApiStatus } from '../../../shared/api'
import { applyReply, useUi } from '../store'
import { useSteadyScroll } from '../useSteadyScroll'
import { CopyButton } from './fields'

/**
 * AI clients in the app (PLAN.md §6.3): connecting them (the Connect AI
 * panel), what they change (a note for each change, undone in one click),
 * and, in review mode, their suggestions to accept or reject.
 */

const undoAi = () => applyReply(window.universe.undoAi())

/** The API's status, kept up to date, a way to change it that shows the change at once, and one to look again (Tailscale too). */
function useApiStatus(): [ApiStatus | undefined, (patch: ApiSettingsPatch) => void, () => void] {
  const [status, setStatus] = useState<ApiStatus>()
  // Changes on their way to the main process: until the last one answers, a status that comes meanwhile was made before it, and would undo what's shown.
  const changing = useRef(0)
  const take = (latest: ApiStatus) => changing.current === 0 && setStatus(latest)
  useEffect(() => {
    void window.universe.apiStatus().then(take)
    return window.universe.onApi(take)
  }, [])
  const set = (patch: ApiSettingsPatch) => {
    const { phone, ...rest } = patch
    setStatus((s) => s && { ...s, ...rest, phone: phone === undefined ? s.phone : { ...s.phone, on: phone } })
    changing.current++
    void window.universe.setApi(patch).then((answer) => --changing.current === 0 && setStatus(answer))
  }
  const refresh = () => void window.universe.apiStatus().then(take)
  return [status, set, refresh]
}

/** A command to copy, in a box that selects it all. */
function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span className="field-label-row">
        {label}
        <CopyButton text={value} className="link small" />
      </span>
      <textarea className="copy-field" readOnly rows={3} value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
    </div>
  )
}

/** The topbar button that opens the Connect AI panel, lit while AI clients can connect. */
export function ConnectAiButton() {
  const [status, set, refresh] = useApiStatus()
  const [open, setOpen] = useState(false)
  const on = !!status?.enabled && status.port !== null
  return (
    <div className="connect-ai">
      {/* Opening looks again: Tailscale may have been installed or signed in to since. */}
      <button
        aria-expanded={open}
        onClick={() => {
          if (!open) refresh()
          setOpen(!open)
        }} title={on ? `AI clients can connect on 127.0.0.1:${status!.port}` : 'Connect Claude or another AI client'}>
        <span className={`connect-dot${on ? ' on' : ''}`} aria-hidden /> Connect AI
      </button>
      {open && status && <ConnectPanel status={status} set={set} onClose={() => setOpen(false)} />}
      {/* A client signing in needs its code even with the panel closed. */}
      {!open && !!status?.phone.signIns.length && (
        <div className="sign-in-popover">
          <SignInCodes signIns={status.phone.signIns} />
        </div>
      )}
    </div>
  )
}

function ConnectPanel({ status, set, onClose }: { status: ApiStatus; set(patch: ApiSettingsPatch): void; onClose(): void }) {
  const [showToken, setShowToken] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  useSteadyScroll(body, 'connect')
  return (
    <section className="connect-panel" aria-label="Connect AI">
      <div className="connect-body" ref={body}>
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
        <p className="small muted">Review happens here, in the app. While the app doesn’t have a project open, a stdio server writes to its file directly.</p>
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
        <PhoneAccess status={status} set={set} />
      </div>
    </section>
  )
}

/** What phone access is doing, in a line. */
function phoneLine({ enabled, phone }: ApiStatus): string {
  const ts = phone.tailscale
  if (!enabled) return 'Turn on “Let AI connect” first.'
  if (ts.kind === 'missing') return 'Needs Tailscale: install it from tailscale.com and sign in, then open this panel again.'
  if (ts.kind === 'stopped') return `${ts.detail}. Start it and sign in, then open this panel again.`
  if (!phone.on) return `Off. Tailscale is ready on ${ts.host}.`
  if (phone.url) return `On, through Tailscale Funnel at https://${ts.host}.`
  return phone.error ? 'Funnel isn’t on yet:' : 'Turning on Funnel…'
}

/**
 * Phone access (PLAN.md §6.4): Claude on a phone, or claude.ai anywhere,
 * reaching this app through Tailscale Funnel; a client signs in with a code
 * shown here, and can be disconnected here.
 */
function PhoneAccess({ status, set }: { status: ApiStatus; set(patch: ApiSettingsPatch): void }) {
  const { phone } = status
  const day = (ms: number) => new Date(ms).toLocaleDateString()
  return (
    <section className="phone-access" aria-label="From your phone">
      <h3>From your phone</h3>
      <p className="small muted">
        Claude on your phone reaches this app through Tailscale Funnel, a public address for this computer that forwards here. A client signs in with a code shown here, then can do what Claude Code can.
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={phone.on} disabled={!status.enabled} onChange={(e) => set({ phone: e.target.checked })} /> Let Claude on my phone connect
      </label>
      <p className="small" aria-label="Phone access status">
        {phoneLine(status)}
      </p>
      {phone.error && (
        <p className="small phone-error" role="alert">
          {phone.error}
        </p>
      )}
      {phone.url && <CopyField label="Add it on claude.ai as a custom connector (Settings → Connectors), then use it from the Claude app" value={phone.url} />}
      {phone.signIns.length > 0 && <SignInCodes signIns={phone.signIns} />}
      {phone.connections.length > 0 && (
        <div className="field">
          <span>Connected</span>
          <ul className="connections" aria-label="Connected clients">
            {phone.connections.map((c) => (
              <li key={c.id}>
                <span>
                  {c.name} <span className="muted">· added {day(c.created)} · last used {day(c.lastUsed)}</span>
                </span>
                <button className="link small" onClick={() => void window.universe.removeConnection(c.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** The code each client signing in needs typed on its page, to let it in (or turn it down). */
function SignInCodes({ signIns }: { signIns: ApiStatus['phone']['signIns'] }) {
  return (
    <div className="sign-in-codes" role="status" aria-label="Sign-in codes">
      {signIns.map((s) => (
        <div key={s.id} className="sign-in-code">
          <span className="small">
            🔑 <b>{s.client}</b> is signing in, to send its access to <b>{s.to}</b>. If that’s yours, type this code on its page:
          </span>
          <code aria-label={`Code for ${s.client}`}>{s.code}</code>
          <button className="link small" onClick={() => void window.universe.denySignIn(s.id)}>
            Turn it down
          </button>
        </div>
      ))}
    </div>
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
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const off = window.universe.onAiChange((change) => {
      const note = { ...change, key: key++ }
      setNotes((list) => [...list.slice(-3), note])
      const timer = setTimeout(() => {
        timers.delete(timer)
        setNotes((list) => list.filter((n) => n !== note))
      }, 8000)
      timers.add(timer)
    })
    return () => {
      off()
      timers.forEach(clearTimeout)
    }
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
