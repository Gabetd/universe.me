import { useEffect, useState } from 'react'
import { CHANNELS, type Channel, type ChannelVersion } from '../../../shared/update'
import { Modal, dialogStore } from './Modal'

/** Whether the Change version dialog is open (the button, or Help → Change Version…). */
export const useVersionsDialog = dialogStore()

/** Opens Change version: the start screen's and the status bar's button. */
export function ChangeVersion() {
  return (
    <button className="link change-version" onClick={() => useVersionsDialog.getState().set(true)}>
      Change version
    </button>
  )
}

/**
 * Change version: Live, Staging and Dev, each with its newest build. This
 * copy's own is checked for an update (shown in the update banner, as ever);
 * another is its own app (Universe (dev), say), installed beside this one
 * and opened, keeping its own settings and updating from its own builds.
 */
export function VersionsDialog() {
  const open = useVersionsDialog((s) => s.open)
  // Mounted afresh each time it opens, so it starts from nothing known.
  return open ? <Versions /> : null
}

const close = () => useVersionsDialog.getState().set(false)

function Versions() {
  const [versions, setVersions] = useState<ChannelVersion[] | null>(null)
  /** Why this copy has nothing to update to; null once an update is offered (in the banner too); undefined while checking. */
  const [answer, setAnswer] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState<Channel | null>(null)
  const [message, setMessage] = useState<{ channel: Channel; text: string } | null>(null)

  useEffect(() => {
    // Asks for this copy's update too (offering again one that was dismissed): one found shows in the banner.
    void window.universe.checkForUpdates().then(setAnswer)
    void window.universe.versions().then(setVersions)
  }, [])

  const install = async (channel: Channel) => {
    setBusy(channel)
    setMessage(null)
    try {
      const why = await window.universe.installVersion(channel)
      setMessage({ channel, text: why ?? `${CHANNELS[channel].name} is installed beside this one, and opening.` })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal title="Change version" closeLabel="Close Change version" className="versions-dialog" onClose={close}>
      <p className="muted small">Staging and Dev are apps of their own: each installs beside this one, keeps its own settings and recent projects, and updates to newer builds of its own.</p>
      {!versions ? (
        <p className="muted" role="status">
          Looking on GitHub…
        </p>
      ) : (
        <ul className="plain-list version-list" aria-label="Versions">
          {versions.map((v) => {
            const info = CHANNELS[v.channel]
            return (
              <li key={v.channel} aria-label={info.label} className={v.current ? 'current' : undefined}>
                <div>
                  <b>{info.label}</b> <span className="muted">· {info.name}</span>
                  {v.current && <span className="badge">this copy</span>}
                  <div className="muted small">
                    {info.about}
                    {v.current && ` This copy is ${__BUILD_INFO__.version}.`}
                  </div>
                </div>
                <div className="version-action">
                  <span className="version-number">{v.version ?? '—'}</span>
                  {v.current && answer === null ? (
                    <button className="primary" onClick={() => void window.universe.installUpdate()}>
                      Update to {v.version}
                    </button>
                  ) : v.current ? (
                    <span className="small" role="status" aria-label="Update check">
                      {answer === undefined ? 'Checking for an update…' : answer}
                    </span>
                  ) : v.error ? (
                    <span className="muted small">{v.error}</span>
                  ) : v.installable ? (
                    <button disabled={busy !== null} onClick={() => void install(v.channel)}>
                      {busy === v.channel ? 'Installing…' : `Install ${info.name}`}
                    </button>
                  ) : (
                    <span className="muted small">Download it from the project’s releases on GitHub.</span>
                  )}
                  {message?.channel === v.channel && (
                    <span className="small" role="status" aria-label={`${info.label} install`}>
                      {message.text}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
