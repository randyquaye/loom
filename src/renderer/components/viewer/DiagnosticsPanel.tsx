import { useState } from 'react'
import type { Diagnostic } from '../../../shared/ipc-contract'
import { Dropdown, type DropdownOption } from '../ui/Dropdown'
import '../panels/panels.css'

const SEVERITY_OPTIONS: DropdownOption[] = [
  { value: 'all', label: 'All' },
  { value: 'error', label: 'Errors' },
  { value: 'warning', label: 'Warnings' },
  { value: 'info', label: 'Info' }
]

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function DiagnosticsPanel({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const [open, setOpen] = useState(false)
  const [severity, setSeverity] = useState('all')
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length
  const shown = severity === 'all' ? diagnostics : diagnostics.filter((d) => d.severity === severity)

  if (diagnostics.length === 0) {
    return (
      <div className="diag-drawer">
        <div className="diag-summary diag-clean">No diagnostics</div>
      </div>
    )
  }

  return (
    <div className="diag-drawer">
      <div className="diag-summary">
        <button className="diag-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="tree-caret" data-open={open} aria-hidden="true">
            ▸
          </span>
          <span className="diag-count">
            <span className="sev-dot" data-severity="error" />
            {plural(errors, 'error')}
          </span>
          <span className="diag-count">
            <span className="sev-dot" data-severity="warning" />
            {plural(warnings, 'warning')}
          </span>
        </button>
        {open && <Dropdown value={severity} options={SEVERITY_OPTIONS} onChange={setSeverity} />}
      </div>
      {open && (
        <div className="diag-list">
          {shown.map((d, index) => (
            <div key={index} className="diag">
              <span className="sev-dot" data-severity={d.severity} />
              <span className="diag-loc">
                {d.line}:{d.column}
              </span>
              <span className="diag-msg">{d.message}</span>
              <span className="diag-loc">{d.source}</span>
            </div>
          ))}
          {shown.length === 0 && <div className="panel-empty">Nothing at this severity</div>}
        </div>
      )}
    </div>
  )
}
