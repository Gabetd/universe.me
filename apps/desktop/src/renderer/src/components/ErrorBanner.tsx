import { useUi } from '../store'

export function ErrorBanner() {
  const error = useUi((s) => s.error)
  const dismiss = useUi((s) => s.dismissError)
  if (!error) return null
  return (
    <div className="error-banner" role="alert">
      <span>{error}</span>
      <button className="link" onClick={dismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  )
}
