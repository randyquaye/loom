/**
 * A failed load, said plainly with a way out. Used wherever a fetch can fail so the
 * failure never masquerades as an empty list or an endless "Loading…".
 */
export function ErrorState({
  title,
  detail,
  onRetry,
  compact = false
}: {
  title: string
  detail?: string | undefined
  onRetry: () => void
  compact?: boolean
}) {
  return (
    <div className={`error-state${compact ? ' error-state-compact' : ''}`} role="alert">
      <span className="error-state-title">{title}</span>
      {detail !== undefined && !compact && <span>{detail}</span>}
      <button type="button" className="btn" onClick={onRetry} title={compact ? detail : undefined}>
        Retry
      </button>
    </div>
  )
}
