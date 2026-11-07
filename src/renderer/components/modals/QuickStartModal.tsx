import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProjectRow } from '../../../shared/ipc-contract'
import { useProjects } from '../../state/projects'
import { Field } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { useToasts } from '../ui/Toast'

const DEFAULT_NAME = 'quickstart'
/** Main's IPC schema caps the name; its slug is capped separately. */
const MAX_NAME = 64
const MAX_SLUG = 48

/** Mirrors main's slugify (src/main/git/slug.ts): the folder and project name quick start uses. */
function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '')
  return slug === '' ? 'untitled' : slug
}

/**
 * Names a quick-start repository before main creates it. Portalled to body: it opens from a menu
 * inside the glass New Workspace modal, whose backdrop-filter would contain a fixed overlay.
 */
export function QuickStartModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (project: ProjectRow) => void
}) {
  const load = useProjects((s) => s.load)
  const push = useToasts((s) => s.push)
  const [name, setName] = useState(DEFAULT_NAME)
  const [busy, setBusy] = useState(false)
  const slug = slugify(name)
  const ready = name.trim() !== '' && !busy

  // Every open Modal hears Escape on window; capture it first so the modal beneath stays open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  async function submit() {
    if (!ready) return
    setBusy(true)
    let project: ProjectRow
    try {
      project = await window.loom.projects.quickstart(name.trim())
    } catch (err) {
      const taken = String(err).includes('PROJECT_LOCATION_REJECTED')
      push(
        taken ? `A project folder named ${slug} already exists` : `Quick start failed: ${String(err)}`,
        'err'
      )
      setBusy(false)
      return
    }
    await load()
    push(`Created ${project.name}`)
    onCreated(project)
  }

  return createPortal(
    <Modal
      open
      title="Quick start project"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <Field label="Name" hint={`Creates a new git repository named ${slug}`}>
        <input
          className="input"
          autoFocus
          maxLength={MAX_NAME}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
      </Field>
    </Modal>,
    document.body
  )
}
