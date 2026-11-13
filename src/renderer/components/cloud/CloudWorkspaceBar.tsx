import { useEffect, useRef, useState } from 'react'
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
  setupFailed
}: {
  workspaceId: string
  setupReady: boolean
  setupFailed: boolean
}) {
  const status = useCloud((state) => state.status)
  const power = useWorkspacePower((state) => state.byWorkspace[workspaceId])
  const connected = status.state === 'connected'
  const push = useToasts((state) => state.push)
  const opened = useRef<string | null>(null)
  const [forwards, setForwards] = useState<PortForward[]>([])
  const [port, setPort] = useState('')
  const [localPort, setLocalPort] = useState('')
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
        : 'Workspace setup must finish before starting.'
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
      await window.loom.ports.forward(workspaceId, Number(port), localPort === '' ? 0 : Number(localPort))
      setForwards(await window.loom.ports.list(workspaceId))
      setPort('')
      setLocalPort('')
    } catch (error) {
      push(String(error), 'err')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="cloud-workspace" data-state={connected ? power?.state : status.state}>
      <div className="cloud-workspace-status">
        <span role="status" className="grow">
          {message}
        </span>
        <button
          className="btn btn-ghost"
          type="button"
          disabled={!connected || (!setupReady && !(setupFailed && stopping)) || working || transition}
          title={
            stopping
              ? 'Stop running turns and terminals; keep files and queued messages'
              : 'Start the workspace without sending a message'
          }
          onClick={() => void toggle()}
        >
          {stopping ? 'Stop' : 'Start'}
        </button>
      </div>
      {health?.disk.warning && (
        <div className="cloud-disk-warning" role="alert">
          Cloud data disk is nearly full: {(health.disk.available / 1024 ** 3).toFixed(1)} GB available.
        </div>
      )}
      <details className="cloud-ports">
        <summary>Ports{forwards.length > 0 ? ` (${forwards.length})` : ''}</summary>
        <p>Reach a workspace dev server in this Mac’s browser.</p>
        {forwards.map((mapping) => (
          <div className="cloud-port-mapping" key={mapping.port}>
            <span>Workspace :{mapping.port} →</span>
            <button
              className="btn btn-ghost"
              type="button"
              disabled={!connected || power?.state !== 'running'}
              onClick={() => void window.loom.shell.openExternal(`http://127.0.0.1:${mapping.localPort}`)}
            >
              localhost:{mapping.localPort} ↗
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              aria-label={`Stop forwarding port ${mapping.port}`}
              onClick={() => {
                void window.loom.ports
                  .unforward(workspaceId, mapping.port)
                  .then(() => window.loom.ports.list(workspaceId))
                  .then(setForwards)
                  .catch((error: unknown) => push(String(error), 'err'))
              }}
            >
              Remove
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
          <label>
            Local port
            <input
              className="input mono"
              type="number"
              min={1024}
              max={65535}
              value={localPort}
              onChange={(event) => setLocalPort(event.target.value)}
              placeholder="Automatic"
            />
          </label>
          <button
            className="btn btn-ghost"
            type="submit"
            disabled={!connected || power?.state !== 'running' || working || port === ''}
          >
            Forward
          </button>
        </form>
      </details>
    </div>
  )
}
