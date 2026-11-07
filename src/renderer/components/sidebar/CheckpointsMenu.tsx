import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { CheckpointInfo, WorkspaceRow } from '../../../shared/ipc-contract'
import { useFiles } from '../../state/files'
import { Modal } from '../ui/Modal'
import { Popover } from '../ui/Popover'
import { useToasts } from '../ui/Toast'

function relativeTime(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Anchored to the workspace actions button, outside the sidebar's scroll and glass containers. */
export function CheckpointsMenu({
  workspace,
  anchorRef,
  onClose
}: {
  workspace: WorkspaceRow
  anchorRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restoring, setRestoring] = useState<CheckpointInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [position, setPosition] = useState<{
    left: number
    top?: number
    bottom?: number
    maxHeight: number
  }>({ left: 16, top: 16, maxHeight: 360 })
  const saveRef = useRef<HTMLButtonElement>(null)
  const pendingRef = useRef(false)
  const push = useToasts((s) => s.push)
  const loading = checkpoints === null && !loadFailed
  const closeRestore = useCallback(() => {
    if (!pendingRef.current) setRestoring(null)
  }, [])

  useLayoutEffect(() => {
    function positionMenu() {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const width = Math.min(320, window.innerWidth - 32)
      const below = window.innerHeight - rect.bottom - 24
      const above = rect.top - 24
      const up = below < Math.min(360, above)
      setPosition({
        left: Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16)),
        ...(up ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
        maxHeight: Math.min(360, Math.max(0, up ? above : below))
      })
    }
    positionMenu()
    window.addEventListener('resize', positionMenu)
    document.addEventListener('scroll', positionMenu, true)
    return () => {
      window.removeEventListener('resize', positionMenu)
      document.removeEventListener('scroll', positionMenu, true)
    }
  }, [anchorRef])

  useEffect(() => {
    let active = true
    window.loom.git.checkpoints(workspace.id).then(
      (rows) => {
        if (active) setCheckpoints(rows)
      },
      (err: unknown) => {
        if (!active) return
        setLoadFailed(true)
        push(`Could not load checkpoints: ${String(err)}`, 'err')
      }
    )
    return () => {
      active = false
    }
  }, [workspace.id, push])

  useEffect(() => {
    // IPC can resolve after Popover's autofocus frame, or re-enable the saved action.
    if (
      !loading &&
      !saving &&
      restoring === null &&
      (document.activeElement === document.body || document.activeElement === anchorRef.current)
    ) {
      saveRef.current?.focus()
    }
  }, [loading, saving, restoring, anchorRef])

  async function save() {
    if (pendingRef.current || loading) return
    pendingRef.current = true
    setSaving(true)
    try {
      await window.loom.git.saveCheckpoint(workspace.id, 'manual checkpoint')
    } catch (err) {
      push(`Could not save checkpoint: ${String(err)}`, 'err')
      pendingRef.current = false
      setSaving(false)
      return
    }
    push('Saved checkpoint')
    try {
      setCheckpoints(await window.loom.git.checkpoints(workspace.id))
      setLoadFailed(false)
    } catch (err) {
      setCheckpoints(null)
      setLoadFailed(true)
      push(`Could not reload checkpoints: ${String(err)}`, 'err')
    } finally {
      pendingRef.current = false
      setSaving(false)
    }
  }

  async function restore() {
    if (restoring === null || pendingRef.current) return
    pendingRef.current = true
    setBusy(true)
    let restored = false
    try {
      await window.loom.git.restoreCheckpoint(workspace.id, restoring.id)
      restored = true
      const files = useFiles.getState()
      await Promise.all([
        files.refresh(workspace.id),
        ...(files.changesByWorkspace[workspace.id] !== undefined ? [files.loadChanges(workspace.id)] : [])
      ])
      push(`Restored checkpoint for ${workspace.name}`)
    } catch (err) {
      push(
        restored
          ? `Restored checkpoint, but could not refresh ${workspace.name}: ${String(err)}`
          : `Could not restore checkpoint for ${workspace.name}: ${String(err)}`,
        'err'
      )
    } finally {
      pendingRef.current = false
      setBusy(false)
      onClose()
    }
  }

  return createPortal(
    <>
      <div className="popover-wrap checkpoints-anchor" style={position}>
        <Popover
          open={restoring === null}
          onClose={onClose}
          anchorRef={anchorRef}
          className="checkpoints-menu"
        >
          <div className="checkpoints-head" role="presentation">
            <span className="grow">Checkpoints</span>
            <button
              ref={saveRef}
              type="button"
              role="menuitem"
              className="btn btn-ghost"
              disabled={loading || saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save now'}
            </button>
          </div>
          <div className="checkpoints-list" role="presentation" aria-busy={loading || saving}>
            {loading ? (
              <div className="checkpoints-empty" role="status">
                Loading checkpoints…
              </div>
            ) : loadFailed ? (
              <div className="checkpoints-empty" role="status">
                Could not load checkpoints. Reopen to try again.
              </div>
            ) : checkpoints?.length === 0 ? (
              <div className="checkpoints-empty" role="status">
                No checkpoints yet.
              </div>
            ) : (
              checkpoints?.map((checkpoint) => (
                <div key={checkpoint.id} className="checkpoint-row" role="presentation">
                  <div className="checkpoint-copy" role="presentation">
                    <span className="checkpoint-label" title={checkpoint.label}>
                      {checkpoint.label}
                    </span>
                    <time
                      className="checkpoint-time"
                      dateTime={new Date(checkpoint.at).toISOString()}
                      title={new Date(checkpoint.at).toLocaleString()}
                    >
                      {relativeTime(checkpoint.at)}
                    </time>
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="icon-btn"
                    title="Restore checkpoint"
                    aria-label={`Restore checkpoint: ${checkpoint.label}`}
                    disabled={saving}
                    onClick={() => setRestoring(checkpoint)}
                  >
                    <svg
                      className="icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6M12 7v5l3 2" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="icon-btn"
                    title="View diff"
                    aria-label={`View diff for checkpoint: ${checkpoint.label}`}
                    disabled={saving}
                    onClick={() => {
                      void useFiles.getState().openCheckpointDiff(workspace.id, checkpoint.id)
                      onClose()
                    }}
                  >
                    <svg
                      className="icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M14 3H5v18h14V8zM14 3v5h5M8 11h5M10.5 8.5v5M8 17h5" />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>
        </Popover>
      </div>
      {restoring !== null && (
        <Modal
          open
          title="Restore checkpoint"
          className="checkpoint-confirm"
          onClose={closeRestore}
          footer={
            <>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={closeRestore}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void restore()}>
                {busy ? 'Restoring…' : 'Restore checkpoint'}
              </button>
            </>
          }
        >
          <p className="ws-confirm">
            Restore <strong>{restoring.label}</strong> in <strong>{workspace.name}</strong>? Uncommitted
            worktree changes will be replaced by this checkpoint.
          </p>
        </Modal>
      )}
    </>,
    document.body
  )
}
