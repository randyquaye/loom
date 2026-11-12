import { useCallback, useEffect, useState } from 'react'
import { Modal } from '../../components/ui/Modal'
import { CopyIcon } from '../../components/ui/icons'

const COMMANDS = { claude: 'claude', codex: 'codex login', github: 'gh auth login' }
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
  const [hint, setHint] = useState<string | null>(null)
  const loadHint = useCallback(async () => {
    if (provider === null) return null
    const status =
      provider === 'github'
        ? (await window.loom.integrations.status()).github
        : (await window.loom.providers.status())[provider]
    return 'hint' in status ? status.hint : null
  }, [provider])
  useEffect(() => {
    let live = true
    setCopied(false)
    setError(null)
    setHint(null)
    void loadHint()
      .then((next) => {
        if (live) setHint(next)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [loadHint])
  return (
    <Modal
      open={provider !== null}
      title={`Connect ${provider === null ? '' : NAMES[provider]} on this Mac`}
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
                .then(loadHint)
                .then(setHint)
                .catch(() => setError('Could not check. Try again.'))
                .finally(() => setChecking(false))
            }}
          >
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </>
      }
    >
      <p className="settings-note">Run this command in a terminal on your Mac and finish signing in.</p>
      {hint !== null && <p className="settings-note">{hint}</p>}
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
          Loom can check that the CLI is installed. Your CLI manages its own login.
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
