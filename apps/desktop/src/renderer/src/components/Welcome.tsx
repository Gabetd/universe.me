import { useEffect, useState } from 'react'
import { ROADMAP } from '../roadmap'
import { applyReply } from '../store'
import { ErrorBanner } from './ErrorBanner'
import { CheckForUpdates } from './UpdateBanner'
import { DevicesPanel } from './AiPanels'

export function Welcome() {
  const [recent, setRecent] = useState<string[]>([])

  useEffect(() => {
    void window.universe.recentProjects().then(setRecent)
  }, [])

  return (
    <div className="welcome">
      <ErrorBanner />
      <div className="welcome-inner">
        <header className="welcome-hero">
          <h1>Universe</h1>
          <p>Build worlds, their skies, and their histories.</p>
          <div className="welcome-actions">
            <button className="primary" onClick={() => void applyReply(window.universe.newProject())}>
              New Universe…
            </button>
            <button onClick={() => void applyReply(window.universe.openProject())}>Open…</button>
          </div>
        </header>

        <div className="welcome-columns">
          <section>
            <h2>Recent</h2>
            {recent.length === 0 ? (
              <p className="muted">Nothing yet. Create a universe to get started.</p>
            ) : (
              <ul className="recent-list">
                {recent.map((path) => (
                  <li key={path}>
                    <button className="link" title={path} onClick={() => void applyReply(window.universe.openProject(path))}>
                      <span className="recent-name">{fileName(path)}</span>
                      <span className="recent-path">{path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {/* A universe open on another of the user's computers can be copied here (PLAN.md §6.7). */}
          <DevicesPanel />

          <section>
            <h2>Build progress</h2>
            <ol className="roadmap">
              {ROADMAP.map((m) => (
                <li key={m.id} className={`roadmap-item ${m.status}`}>
                  <span className="roadmap-dot" aria-hidden />
                  <div>
                    <div className="roadmap-title">
                      <strong>{m.id}</strong> {m.title}
                      {m.status === 'active' && <span className="badge">in progress</span>}
                      {m.status === 'done' && <span className="badge done">done</span>}
                    </div>
                    <div className="muted small">{m.summary}</div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <footer className="muted small welcome-footer">
          Version {__BUILD_INFO__.version} · build {__BUILD_INFO__.commit}
          <CheckForUpdates />
        </footer>
      </div>
    </div>
  )
}

function fileName(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.universe$/, '')
}
