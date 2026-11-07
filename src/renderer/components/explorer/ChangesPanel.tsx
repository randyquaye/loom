import type { ChangeEntry } from '../../../shared/ipc-contract'
import { useFiles } from '../../state/files'
import '../panels/panels.css'

/** Staged then unstaged; an untracked file occupies the unstaged column. */
function chipGlyphs(entry: ChangeEntry): string {
  if (entry.status === 'untracked') return '·U'
  const letter =
    entry.status === 'modified'
      ? 'M'
      : entry.status === 'added'
        ? 'A'
        : entry.status === 'deleted'
          ? 'D'
          : 'R'
  return `${entry.staged ? letter : '·'}${entry.unstaged ? letter : '·'}`
}

export function ChangesPanel({ workspaceId, error }: { workspaceId: string; error: string | null }) {
  const changes = useFiles((s) => s.changesByWorkspace[workspaceId])
  const openDiff = useFiles((s) => s.openDiff)
  const openPath = useFiles((s) => s.openPathByWorkspace[workspaceId] ?? null)
  const mode = useFiles((s) => s.viewerModeByWorkspace[workspaceId] ?? 'content')

  return (
    <div className="tree changes-list">
      {error !== null && (
        <div className="panel-empty" role="status" title={error}>
          Could not load changes. Try refreshing.
        </div>
      )}
      {changes === undefined ? (
        error === null && (
          <div className="panel-empty" role="status">
            Loading changes…
          </div>
        )
      ) : changes.length === 0 ? (
        <div className="panel-empty">No uncommitted changes.</div>
      ) : (
        changes.map((entry) => {
          const selected = openPath === entry.path && mode === 'diff'
          const status = `${entry.status}${entry.staged ? ', staged' : ''}${entry.unstaged ? ', unstaged' : ''}`
          return (
            <button
              type="button"
              key={entry.path}
              className={`tree-row change-row${selected ? ' tree-on' : ''}`}
              title={entry.path}
              aria-label={`${entry.path}, ${status}`}
              aria-current={selected ? 'true' : undefined}
              onClick={() => void openDiff(workspaceId, entry.path)}
            >
              <span className="change-chip" data-status={entry.status} aria-hidden="true" title={status}>
                {chipGlyphs(entry)}
              </span>
              <span className="tree-name change-path">{entry.path}</span>
            </button>
          )
        })
      )}
    </div>
  )
}
