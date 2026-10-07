import { Component, type ReactNode } from 'react'

/** Shows what went wrong instead of a blank window if rendering throws. The project file is untouched. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash" role="alert">
        <h2>Something went wrong</h2>
        <p className="muted">Your project is saved; nothing was lost. Reload the window to continue.</p>
        <pre>{error.message}</pre>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    )
  }
}
