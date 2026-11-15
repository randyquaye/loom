import { useId, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ProjectRow } from '../../../shared/ipc-contract'
import { useProjects } from '../../state/projects'
import { MOD_KEY } from '../ui/CommandPalette'
import { Field } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { useToasts } from '../ui/Toast'
import { tildePath } from './ProjectMenu'
import './project-menu.css'

const FORM_ID = 'clone-repo-form'

function providerOf(url: string): string {
  const host = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i.exec(url)?.[1]?.toLowerCase() ?? ''
  return ['github', 'gitlab', 'bitbucket'].find((p) => host.includes(p)) ?? 'other'
}

/**
 * Clone a remote into the Loom repos folder (or a picked location). "Recent repos" lists known
 * projects with a remote so a URL can be reused; failures keep the form intact for a retry. A
 * leftover clone slot from a removed project is a choice, not a dead end: the modal offers to
 * replace it (deleting the leftover) or keep it and stay on the form.
 */
export function CloneRepoModal({
  onClose,
  onCloned
}: {
  onClose: () => void
  onCloned: (project: ProjectRow) => void
}) {
  const projects = useProjects((s) => s.projects)
  const adoptProject = useProjects((s) => s.adoptProject)
  const push = useToasts((s) => s.push)
  const [url, setUrl] = useState('')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [location, setLocation] = useState('')
  const [busy, setBusy] = useState(false)
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null)
  const baseId = useId()

  const q = query.trim().toLowerCase()
  const repos = projects.filter(
    (p): p is ProjectRow & { remoteUrl: string } =>
      p.remoteUrl !== null && `${p.name} ${p.remoteUrl} ${p.repoPath}`.toLowerCase().includes(q)
  )
  const activeIndex = Math.min(active, Math.max(repos.length - 1, 0))
  const ready = url.trim() !== '' && !busy

  async function submit(overwrite = false, e?: FormEvent) {
    e?.preventDefault()
    if (!ready) return
    setBusy(true)
    const target = location.trim()
    try {
      const project = await window.loom.projects.clone(url.trim(), target === '' ? null : target, overwrite)
      setReplaceTarget(null)
      await adoptProject(project)
      onCloned(project)
    } catch (err) {
      // A leftover clone slot from a removed project is a choice, not a dead end.
      const leftoverPath = /PROJECT_LOCATION_EXISTS: (.+) already exists/.exec(String(err))?.[1]
      if (leftoverPath !== undefined) {
        setReplaceTarget(leftoverPath)
        setBusy(false)
        return
      }
      push(`Clone failed: ${String(err)}`, 'err')
      setBusy(false)
    }
  }

  async function browse() {
    try {
      const path = await window.loom.projects.pickFolder()
      if (path !== null) setLocation(path)
    } catch (err) {
      push(`Could not open folder picker: ${String(err)}`, 'err')
    }
  }

  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && repos.length > 0) {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((activeIndex + step + repos.length) % repos.length)
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      const repo = repos[activeIndex]
      if (repo === undefined) return
      // Enter in the search box picks the highlighted repo rather than submitting.
      e.preventDefault()
      setUrl(repo.remoteUrl)
    }
  }

  return (
    <Modal
      open
      title="Clone GitHub repo"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} className="btn btn-primary" disabled={!ready}>
            {busy ? 'Cloning…' : 'Clone repo'}
            <span className="clone-kbd" aria-hidden="true">
              {MOD_KEY}↵
            </span>
          </button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="clone-form"
        onSubmit={(e) => void submit(false, e)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
        }}
      >
        {replaceTarget !== null && (
          <div className="clone-exists elevated" role="alertdialog" aria-label="Replace leftover folder">
            <p className="clone-exists-title">
              A leftover clone folder exists at <code className="md-code">{tildePath(replaceTarget)}</code>.
            </p>
            <p>Replacing deletes everything inside it and clones fresh.</p>
            <div className="clone-exists-actions">
              <button type="button" className="btn" onClick={() => setReplaceTarget(null)}>
                Keep it
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void submit(true)}
              >
                {busy ? 'Cloning…' : 'Replace and clone'}
              </button>
            </div>
          </div>
        )}
        <Field label="Repository URL">
          <input
            data-autofocus
            className="input mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/user/repo.git"
            spellCheck={false}
          />
        </Field>
        <div className="field">
          <Field label="Recent repos">
            <input
              className="input"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={onSearchKey}
              placeholder="Search repositories…"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${baseId}-list`}
              aria-activedescendant={repos.length > 0 ? `${baseId}-row-${activeIndex}` : undefined}
            />
          </Field>
          <div id={`${baseId}-list`} className="clone-list" role="listbox" aria-label="Recent repos">
            {repos.length === 0 && (
              <div className="clone-empty">
                {q === '' ? 'No cloned projects yet.' : `No repos match “${query}”.`}
              </div>
            )}
            {repos.map((p, i) => (
              <button
                key={p.id}
                id={`${baseId}-row-${i}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={p.remoteUrl === url}
                className="list-option clone-row"
                data-active={i === activeIndex}
                onMouseMove={() => setActive(i)}
                onClick={() => setUrl(p.remoteUrl)}
              >
                <span className="clone-dot" data-provider={providerOf(p.remoteUrl)} aria-hidden="true" />
                <span className="clone-row-text">
                  <span className="grow clone-name">{p.name}</span>
                  <span className="grow clone-path">{tildePath(p.repoPath)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label" id={`${baseId}-location`}>
            Location
          </span>
          <div className="clone-location">
            <input
              className="input mono"
              aria-labelledby={`${baseId}-location`}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Default: LoomBox repos folder"
              spellCheck={false}
            />
            <button type="button" className="btn" onClick={() => void browse()}>
              Browse
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
