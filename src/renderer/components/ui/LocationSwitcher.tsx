import type { KeyboardEvent } from 'react'
import './location-switcher.css'

export type ConnectionLocation = 'mac' | 'cloud'

export function LocationSwitcher({
  value,
  onChange,
  cloudDisabled = false,
  cloudDisabledReason = 'The cloud runner is not connected',
  label = 'Connection location'
}: {
  value: ConnectionLocation
  onChange: (location: ConnectionLocation) => void
  cloudDisabled?: boolean
  cloudDisabledReason?: string
  label?: string
}) {
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next =
      cloudDisabled || event.key === 'Home'
        ? 'mac'
        : event.key === 'End'
          ? 'cloud'
          : value === 'mac'
            ? 'cloud'
            : 'mac'
    onChange(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-location="${next}"]`)?.focus()
  }
  return (
    <div className="location-switcher" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {(['mac', 'cloud'] as const).map((location) => (
        <button
          key={location}
          type="button"
          role="radio"
          aria-checked={value === location}
          data-location={location}
          tabIndex={value === location || (cloudDisabled && location === 'mac') ? 0 : -1}
          disabled={location === 'cloud' && cloudDisabled}
          title={location === 'cloud' && cloudDisabled ? cloudDisabledReason : undefined}
          onClick={() => onChange(location)}
        >
          {location === 'mac' ? 'This Mac' : 'Cloud'}
        </button>
      ))}
    </div>
  )
}
