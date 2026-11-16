import { useCallback, useEffect, useState } from 'react'
import { Modal } from '../../components/ui/Modal'
import { CopyIcon } from '../../components/ui/icons'
import type { AuthStatus } from '../../../shared/models'
import type { GithubStatus } from '../../../shared/ipc-contract'

const COMMANDS = { claude: 'claude auth login', codex: 'codex login', github: 'gh auth login' }
const NAMES = { claude: 'Claude', codex: 'Codex', github: 'GitHub' }

export function LocalConnectModal({
  provider,
  onClose,
  onRefresh
}: {
  provider: keyof typeof COMMANDS | null
  onClose: () => void
  onRefresh: () => Promise<void>
}) {
  const [copied, setCopied] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<AuthStatus | GithubStatus | null>(null)
  const loadStatus = useCallback(async () => {
    if (provider === null) return null
    return provider === 'github'
      ? (await window.loom.integrations.status()).github
      : (await window.loom.providers.status())[provider]
  }, [provider])
  useEffect(() => {
    let live = true
    setCopied(false)
    setError(null)
    setStatus(null)
    void loadStatus()
      .then((next) => {
        if (live) setStatus(next)
      })
      .catch(() => {
        if (live) setError('Could not check sign-in. Try again.')
      })
    return () => {
      live = false
    }
  }, [loadStatus])
  return (
    <Modal
      open={provider !== null}
      title={`${provider === null ? '' : NAMES[provider]} on this Mac`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Done
          </button>
          <button
            className="btn"
            disabled={checking}
            onClick={() => {
              setChecking(true)
              setError(null)
              void onRefresh()
                .then(loadStatus)
                .then(setStatus)
                .catch(() => setError('Could not check. Try again.'))
                .finally(() => setChecking(false))
            }}
          >
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </>
      }
    >
      <p className="settings-note">
        {status === null
          ? 'Checking sign-in…'
          : status.state === 'ready'
            ? 'Connected. To switch accounts, run this command and sign in again.'
            : 'Run this command in a terminal on your Mac and finish signing in.'}
      </p>
      {status !== null && 'hint' in status && <p className="settings-note">{status.hint}</p>}
      {status?.state === 'error' && <p role="alert">{status.message}</p>}
      <div className="connection-command">
        <code>{provider === null ? '' : COMMANDS[provider]}</code>
        <button
          className="icon-btn"
          type="button"
          aria-label="Copy login command"
          title="Copy command"
          onClick={() => {
            if (provider !== null)
              void navigator.clipboard
                .writeText(COMMANDS[provider])
                .then(() => setCopied(true))
                .catch(() => setError('Could not copy. Select the command to copy it.'))
          }}
        >
          <CopyIcon />
        </button>
      </div>
      {copied && (
        <span role="status" className="settings-note">
          Copied
        </span>
      )}
      {provider !== 'github' && (
        <p className="settings-note">
          Loom checks your CLI’s sign-in status. Your CLI manages its own login.
        </p>
      )}
      {error && (
        <p role="alert" className="connection-error">
          {error}
        </p>
      )}
    </Modal>
  )
}
