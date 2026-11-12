import { LocationSwitcher } from '../ui/LocationSwitcher'
import { useCallback, useRef, useState } from 'react'
import type { BackendId, Effort } from '../../../shared/models'
import { useCloud } from '../../state/cloud'
import { initialChoice, useDefaults } from '../../state/defaults'
import { useProjects } from '../../state/projects'
import { useSessions } from '../../state/sessions'
import { useUi } from '../../state/ui'
import { ModelPicker } from '../chat/ModelPicker'
import { FolderIcon, GlobeIcon } from '../ui/icons'
import { Modal } from '../ui/Modal'
import { Popover } from '../ui/Popover'
import { useToasts } from '../ui/Toast'
import { BaseRefPicker } from './BaseRefPicker'
import { CloneRepoModal } from './CloneRepoModal'
import { ProjectMenu } from './ProjectMenu'
import { workspaceNameFromPrompt } from './workspaceName'
import './new-workspace.css'

interface Choice {
  backend: BackendId
  model: string
  effort: Effort
}

/**
 * Conductor-style "new workspace": pick the project, optionally a base branch, write the first
 * prompt and pick the model. Create makes the workspace (name derived from the prompt), opens
 * it, starts a session on the picked model and sends the prompt as its first turn. It opens
 * prompt-first: focus lands in the prompt and the project list stays closed until asked for.
 */
export function NewWorkspaceModal({
  projectId: initialProjectId,
  projectMenu = false
}: {
  /** null opens with no project chosen; Create waits until one is picked. */
  projectId: string | null
  /** Start with the project menu open (the "New project" entry points). */
  projectMenu?: boolean
}) {
  const closeModals = useUi((s) => s.closeModals)
  const navigate = useUi((s) => s.navigate)
  const projects = useProjects((s) => s.projects)
  const workspacesByProject = useProjects((s) => s.workspacesByProject)
  const addWorkspace = useProjects((s) => s.addWorkspace)
  const createSession = useSessions((s) => s.create)
  const send = useSessions((s) => s.send)
  const modelsByBackend = useSessions((s) => s.modelsByBackend)
  const loadout = useDefaults((s) => s.loadout)
  const push = useToasts((s) => s.push)
  const [projectId, setProjectId] = useState<string | null>(initialProjectId)
  const [baseRef, setBaseRef] = useState<string | null>(null)
  const cloudState = useCloud((s) => s.status.state)
  const [wantsCloud, setWantsCloud] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [picked, setPicked] = useState<Choice | null>(null)
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(projectMenu)
  const [listOpen, setListOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const projectTriggerRef = useRef<HTMLButtonElement>(null)
  // Escape reaches every open Modal's window listener; this one must stay open beneath the clone modal.
  const cloneOpenRef = useRef(cloneOpen)
  cloneOpenRef.current = cloneOpen
  // Stable identity: Modal re-runs its autofocus whenever onClose changes.
  const close = useCallback(() => {
    if (!cloneOpenRef.current) closeModals()
  }, [closeModals])
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  const closeList = useCallback(() => setListOpen(false), [])
  const closeClone = useCallback(() => setCloneOpen(false), [])

  /** Picking a project hands focus back to the prompt: the user is mid-thought, not mid-form. */
  function selectProject(id: string) {
    setProjectId(id)
    setBaseRef(null)
    setMenuOpen(false)
    setListOpen(false)
    promptRef.current?.focus()
  }

  function openClone() {
    setMenuOpen(false)
    setListOpen(false)
    setCloneOpen(true)
  }

  // An issue seeds the prompt; never clobber what the user already typed.
  function seedPrompt(block: string) {
    setPrompt((current) => (current.trim() === '' ? block : `${current}\n\n${block}`))
    promptRef.current?.focus()
  }

  const { backend, model, effort } = picked ?? initialChoice(loadout, modelsByBackend)
  const project = projects.find((p) => p.id === projectId) ?? null
  // A cloud workspace is cloned from the project's remote, so one without a remote cannot have any.
  const cloudOffered = cloudState !== 'off' && project !== null && project.remoteUrl !== null
  const cloudReachable = cloudState === 'connected'
  const inCloud = wantsCloud && cloudOffered && cloudReachable
  const ready = prompt.trim() !== '' && model !== '' && !busy && project !== null

  async function submit() {
    if (!ready || projectId === null) return
    setBusy(true)
    const text = prompt.trim()
    const name = workspaceNameFromPrompt(
      text,
      (workspacesByProject[projectId] ?? []).map((w) => w.name)
    )
    let workspaceId: string
    try {
      workspaceId = (await addWorkspace(projectId, name, baseRef, inCloud)).id
    } catch (err) {
      // Keep the modal and the prompt so the user can pick another project or retry (e.g. at the cap).
      push(`Could not create workspace: ${String(err)}`, 'err')
      setBusy(false)
      return
    }
    // Create the session before navigating so the workspace's first session load already has it.
    let sessionId: string | null = null
    try {
      sessionId = (await createSession(workspaceId, backend, model, effort)).id
    } catch (err) {
      push(`Created ${name}, but could not start a session: ${String(err)}`, 'err')
    }
    close()
    navigate({ name: 'workspace', workspaceId })
    if (sessionId === null) {
      // The workspace opens in compose mode; hand it the prompt so nothing typed is lost.
      useUi.getState().setDraft(text)
      return
    }
    send(sessionId, text).catch((err: unknown) => {
      push(`Send failed: ${String(err)}`, 'err')
      useUi.getState().setDraft(text)
    })
  }

  const head = (
    <>
      <div className="nw-project popover-wrap">
        <div className="dropdown">
          <button
            ref={projectTriggerRef}
            type="button"
            className="dropdown-trigger"
            aria-haspopup="menu"
            aria-expanded={listOpen}
            aria-label={project === null ? 'Choose a project' : `Project: ${project.name}`}
            onClick={() => {
              setMenuOpen(false)
              setListOpen((open) => !open)
            }}
          >
            <span className="grow nw-project-name">{project?.name ?? 'Choose a project…'}</span>
            <span className="dropdown-caret" aria-hidden="true" />
          </button>
        </div>
        <Popover
          open={listOpen}
          onClose={closeList}
          anchorRef={projectTriggerRef}
          className="nw-project-menu"
        >
          {projects.length === 0 ? (
            <div className="popover-label" role="presentation">
              No projects yet
            </div>
          ) : (
            <div className="nw-project-list" role="group" aria-label="Projects">
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="menuitem"
                  className="list-option popover-item"
                  onClick={() => selectProject(p.id)}
                >
                  <span className="grow nw-project-name">{p.name}</span>
                  {p.id === projectId && (
                    <span className="dropdown-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="popover-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="list-option popover-item"
            onClick={() => {
              setListOpen(false)
              setMenuOpen(true)
            }}
          >
            <FolderIcon />
            <span className="grow">Open project…</span>
          </button>
          <button type="button" role="menuitem" className="list-option popover-item" onClick={openClone}>
            <GlobeIcon />
            <span className="grow">Clone a repository…</span>
          </button>
        </Popover>
        <ProjectMenu open={menuOpen} onClose={closeMenu} onPick={selectProject} onClone={openClone} />
      </div>
      <span className="spacer" />
      {cloudOffered && (
        <LocationSwitcher
          value={inCloud ? 'cloud' : 'mac'}
          onChange={(location) => setWantsCloud(location === 'cloud')}
          cloudDisabled={!cloudReachable}
          label="Where the workspace runs"
        />
      )}
      {/* Branches and PRs belong to a repository, so the chip waits for a project. */}
      {projectId !== null && (
        <BaseRefPicker
          cloud={inCloud}
          projectId={projectId}
          value={baseRef}
          onChange={setBaseRef}
          onSeedPrompt={seedPrompt}
          onOpenSettings={(integration) => {
            close()
            navigate({ name: 'settings', page: 'integrations' })
            useUi.getState().setSettingsLocation(integration === 'github' && inCloud ? 'cloud' : 'mac')
          }}
        />
      )}
    </>
  )

  const footer = (
    <>
      <ModelPicker
        backend={backend}
        model={model}
        effort={effort}
        onPick={(b, m, e) => setPicked({ backend: b, model: m, effort: e })}
      />
      <span className="spacer" />
      {project === null && <span className="nw-hint">Choose a project to create</span>}
      {inCloud && <span className="nw-hint">Starts from what is pushed to the remote</span>}
      <button
        type="button"
        className="icon-btn"
        aria-disabled="true"
        aria-label="Add attachment"
        title="Attachments are not available yet"
      >
        +
      </button>
      <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => void submit()}>
        {busy ? 'Creating…' : 'Create'}
        <span className="nw-enter" aria-hidden="true">
          ↵
        </span>
      </button>
    </>
  )

  return (
    <>
      <Modal
        open
        title="New workspace"
        onClose={close}
        head={head}
        footer={footer}
        width={720}
        className="nw-modal"
      >
        <textarea
          ref={promptRef}
          data-autofocus
          className="nw-prompt"
          aria-label="What do you want to work on?"
          placeholder="What do you want to work on?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
      </Modal>
      {/* A sibling, not a child: the glass modal's backdrop-filter would contain a fixed overlay. */}
      {cloneOpen && (
        <CloneRepoModal
          onClose={closeClone}
          onCloned={(project) => {
            selectProject(project.id)
            setCloneOpen(false)
          }}
        />
      )}
    </>
  )
}
