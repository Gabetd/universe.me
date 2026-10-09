import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../../shared/update'

/** Offers a newer build; "Upgrade now" downloads it, installs it and restarts with no further questions. */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'none' })
  useEffect(() => {
    void window.universe.updateStatus().then(setStatus)
    return window.universe.onUpdate(setStatus)
  }, [])
  if (status.state === 'none') return null

  const upgrade = (
    <button className="primary" onClick={() => void window.universe.installUpdate()}>
      {status.state === 'failed' ? 'Try again' : 'Upgrade now'}
    </button>
  )
  const dismiss = (
    <button className="link" aria-label="Dismiss update" onClick={() => void window.universe.dismissUpdate()}>
      ✕
    </button>
  )
  return (
    <div className="update-banner" role="status" aria-label="Update">
      {status.state === 'available' && (
        <>
          <span>
            ✨ Universe <b>{status.version}</b> is available.
            {status.needsPassword && <span className="muted"> Installing asks for your system password.</span>}
          </span>
          {upgrade}
          {dismiss}
        </>
      )}
      {status.state === 'downloading' && (
        <>
          <span>Downloading Universe {status.version}…</span>
          <progress max={1} value={status.progress} aria-label="Download progress" />
          <span className="muted">{Math.round(status.progress * 100)}%</span>
        </>
      )}
      {status.state === 'installing' && <span>Installing Universe {status.version}. It will restart on its own…</span>}
      {status.state === 'failed' && (
        <>
          <span>
            Couldn’t update to {status.version}: {status.error}
          </span>
          {upgrade}
          {dismiss}
        </>
      )}
    </div>
  )
}

/** How long the answer to a check stays next to its button. */
const ANSWER_MS = 8000

/** Looks on GitHub for a newer build: one found shows in the update banner; otherwise the answer shows here for a moment. */
export function CheckForUpdates() {
  const [checking, setChecking] = useState(false)
  const [answer, setAnswer] = useState<string | null>(null)
  useEffect(() => {
    if (!answer) return
    const timer = setTimeout(() => setAnswer(null), ANSWER_MS)
    return () => clearTimeout(timer)
  }, [answer])

  const check = async () => {
    setChecking(true)
    setAnswer(null)
    try {
      setAnswer(await window.universe.checkForUpdates())
    } finally {
      setChecking(false)
    }
  }
  return (
    <span className="update-check">
      {answer && (
        <span role="status" aria-label="Update check">
          {answer}
        </span>
      )}
      <button className="link" disabled={checking} onClick={() => void check()}>
        {checking ? 'Checking for updates…' : 'Check for updates'}
      </button>
    </span>
  )
}
