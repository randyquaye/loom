import { useEffect, useId, useRef, useState } from 'react'
import type { CloudHealth, PortForward, WorkspacePower } from '../../../shared/ipc-contract'
import { useCloud } from '../../state/cloud'
import { subscribeWorkspacePower, useWorkspacePower } from '../../state/workspace-power'
import { useToasts } from '../ui/Toast'
import './cloud-workspace.css'

const POWER_LABELS: Record<WorkspacePower['state'], string> = {
  running: 'Cloud workspace running',
  stopped: 'Workspace stopped. Your files and conversations are saved.',
  starting: 'Starting cloud workspace…',
  stopping: 'Stopping cloud workspace…',
  error: 'Cloud workspace needs attention'
}

export function CloudWorkspaceBar({
  workspaceId,
  setupReady,
  setupFailed,
  setupLogPath
}: {
  workspaceId: string
  setupReady: boolean
  setupFailed: boolean
  setupLogPath?: string | null
}) {
  const status = useCloud((state) => state.status)
  const power = useWorkspacePower((state) => state.byWorkspace[workspaceId])
  const connected = status.state === 'connected'
  const push = useToasts((state) => state.push)
  const opened = useRef<string | null>(null)
  const [forwards, setForwards] = useState<PortForward[]>([])
  const [port, setPort] = useState('')
  const portsId = useId()
  const portInput = useRef<HTMLInputElement>(null)
  const [working, setWorking] = useState(false)
  const [health, setHealth] = useState<CloudHealth | null>(null)

  useEffect(() => {
    subscribeWorkspacePower()
    if (!connected) return
    if (!setupReady) {
      if (setupFailed)
        void useWorkspacePower
          .getState()
          .load(workspaceId)
          .catch((error: unknown) => push(String(error), 'err'))
      return
    }
    // Opening starts the container once. A deliberate stop while this page stays open
    // must not immediately undo itself when the new power state arrives.
    const firstOpen = opened.current !== workspaceId
    opened.current = workspaceId
    const state = useWorkspacePower.getState()
    void (firstOpen ? state.start(workspaceId) : state.load(workspaceId)).catch((error: unknown) =>
      push(String(error), 'err')
    )
  }, [workspaceId, setupReady, setupFailed, connected, push])

  useEffect(() => {
    let disposed = false
    setForwards([])
    if (!connected) return
    void window.loom.ports
      .list(workspaceId)
      .then((ports) => {
        if (!disposed) setForwards(ports)
      })
      .catch((error: unknown) => push(String(error), 'err'))
    return () => {
      disposed = true
    }
  }, [workspaceId, connected, power?.state, push])

  useEffect(() => {
    let disposed = false
    if (!connected) {
      setHealth(null)
      return
    }
    const read = () =>
      void window.loom.cloud
        .health()
        .then((value) => {
          if (!disposed) setHealth(value)
        })
        .catch(() => {})
    read()
    const timer = setInterval(read, 30_000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [connected])

  const message = !connected
    ? status.state === 'signed-out'
      ? 'Signed out of cloud. Sign in under Settings, Cloud.'
      : status.state === 'update'
        ? status.message
        : status.state === 'off'
          ? 'Cloud is disconnected. Choose a runner under Settings, Cloud.'
          : status.state === 'connecting'
            ? 'Connecting to cloud host…'
            : 'Cloud host unreachable. Reconnecting…'
    : !setupReady
      ? setupFailed
        ? (power?.error ?? 'Workspace setup failed. See the setup log.')
        : 'Setting up cloud workspace…'
      : power === undefined
        ? 'Checking cloud workspace…'
        : (power.error ?? POWER_LABELS[power.state])
  const transition = power?.state === 'starting' || power?.state === 'stopping'
  const stopping = power?.state === 'running' || (setupFailed && power?.state === 'error')
  const toggle = async () => {
    setWorking(true)
    try {
      const service = useWorkspacePower.getState()
      if (stopping) await service.stop(workspaceId)
      else await service.start(workspaceId)
    } catch (error) {
      push(String(error), 'err')
    } finally {
      setWorking(false)
    }
  }
  const forward = async () => {
    setWorking(true)
    try {
      await window.loom.ports.forward(workspaceId, Number(port))
      setForwards(await window.loom.ports.list(workspaceId))
      setPort('')
    } catch (error) {
      push(String(error), 'err')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="cloud-workspace" data-state={connected ? power?.state : status.state}>
      <button
        className="btn btn-ghost cloud-ports-trigger"
        type="button"
        popoverTarget={portsId}
        aria-haspopup="dialog"
        aria-label="Forwarded ports"
        title={`Forwarded ports. ${message}`}
        data-warning={health?.disk.warning || setupFailed || power?.state === 'error' || !connected}
      >
        <svg className="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M3 6h14m-4-4 4 4-4 4M17 14H3m4-4-4 4 4 4" />
        </svg>
        {forwards.length > 0 && <span>{forwards.length}</span>}
      </button>
      <button
        className="icon-btn"
        type="button"
        disabled={!connected || (!setupReady && !(setupFailed && stopping)) || working || transition}
        aria-label={stopping ? 'Stop cloud workspace' : 'Start cloud workspace'}
        aria-busy={working || transition}
        title={`${stopping ? 'Stop' : 'Start'} cloud workspace. ${message}`}
        onClick={() => void toggle()}
      >
        <svg className="icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d={stopping ? 'M6 6h8v8H6z' : 'M6 3l11 7-11 7z'} />
        </svg>
      </button>
      <div
        className="cloud-ports"
        id={portsId}
        popover="auto"
        role="dialog"
        aria-labelledby={`${portsId}-title`}
        onToggle={(event) => {
          if (event.newState === 'open') portInput.current?.focus()
        }}
      >
        <div className="row">
          <strong className="grow" id={`${portsId}-title`}>
            Forwarded ports
          </strong>
          <span>{forwards.length}/10</span>
        </div>
        <p role="status">{message}</p>
        {setupFailed && setupLogPath && <p className="mono">Setup log: {setupLogPath}</p>}
        {health?.disk.warning && (
          <div className="cloud-disk-warning" role="alert">
            Cloud data disk is nearly full: {(health.disk.available / 1024 ** 3).toFixed(1)} GB available.
          </div>
        )}
        {forwards.map((mapping) => (
          <div className="cloud-port-mapping" key={mapping.port}>
            <span>:{mapping.port} →</span>
            <button
              className="btn btn-ghost"
              type="button"
              disabled={!connected || power?.state !== 'running'}
              onClick={() => void window.loom.shell.openExternal(`http://127.0.0.1:${mapping.localPort}`)}
            >
              localhost:{mapping.localPort} ↗
            </button>
            <button
              className="icon-btn"
              type="button"
              aria-label={`Stop forwarding port ${mapping.port}`}
              onClick={() => {
                void window.loom.ports
                  .unforward(workspaceId, mapping.port)
                  .then(() => window.loom.ports.list(workspaceId))
                  .then((ports) => {
                    setForwards(ports)
                    portInput.current?.focus()
                  })
                  .catch((error: unknown) => push(String(error), 'err'))
              }}
            >
              ×
            </button>
          </div>
        ))}
        <form
          className="cloud-port-form"
          onSubmit={(event) => {
            event.preventDefault()
            void forward()
          }}
        >
          <label>
            Workspace port
            <input
              ref={portInput}
              className="input mono"
              type="number"
              min={1024}
              max={65535}
              required
              value={port}
              onChange={(event) => setPort(event.target.value)}
              placeholder="4100"
            />
          </label>
          <button
            className="icon-btn"
            type="submit"
            aria-label="Forward port"
            title="Forward port"
            disabled={
              !connected || power?.state !== 'running' || working || port === '' || forwards.length >= 10
            }
          >
            +
          </button>
        </form>
      </div>
    </div>
  )
}
