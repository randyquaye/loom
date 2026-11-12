import { useState } from 'react'
import type { ProjectRow } from '../../../shared/ipc-contract'
import { FIX_ERRORS_PROMPT, REVIEW_DIFF_PROMPT } from '../../../shared/prompts/flows'
import { useToasts } from '../../components/ui/Toast'
import { useCloud } from '../../state/cloud'
import { useProjects } from '../../state/projects'
import { EnvVarList } from './EnvVarList'
import { InstructionsEditor } from './InstructionsEditor'

type Prompts = { general: string; codeReview: string; fixErrors: string }

function projectPrompts(project: ProjectRow): Prompts {
  return {
    general: project.customPromptGeneral ?? '',
    codeReview: project.customPromptCodeReview ?? '',
    fixErrors: project.customPromptFixErrors ?? ''
  }
}

// Only the flows the project row stores a prompt for; panels follow this order.
const FLOWS: { key: keyof Prompts; title: string; description: string; placeholder: string; rows: number }[] =
  [
    {
      key: 'codeReview',
      title: 'Review',
      description: 'Instructions sent to the agent when it reviews the workspace’s uncommitted changes.',
      placeholder: `Empty uses the built-in default:\n${REVIEW_DIFF_PROMPT}`,
      rows: 4
    },
    {
      key: 'fixErrors',
      title: 'Fix errors',
      description: 'Instructions sent to the agent with the diagnostics when it is asked to fix errors.',
      placeholder: `Empty uses the built-in default:\n${FIX_ERRORS_PROMPT}`,
      rows: 4
    },
    {
      key: 'general',
      title: 'General (recovery)',
      description: 'Not yet merged. Shorten this text or Project instructions, then save to retry.',
      placeholder: '',
      rows: 3
    }
  ]

/** Settings project page: one collapsible panel per flow prompt, saved together, then project env vars and instructions. */
export function ProjectPage({ projectId }: { projectId: string }) {
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId))
  // Cloud values live on the runner, so they can only be shown while it can be asked.
  const cloud = useCloud((s) => s.status.state === 'connected')
  if (project === undefined) {
    return (
      <section className="settings-section">
        <p className="settings-note">That project no longer exists.</p>
      </section>
    )
  }
  // Keyed so switching projects drops the previous project's unsaved draft, open panels and env rows.
  return (
    <>
      <ProjectPrompts key={project.id} project={project} />
      <EnvVarList
        key={`env-${project.id}`}
        scope="project"
        projectId={project.id}
        intro={`Injected into every agent session, terminal and run action in ${project.name}. Values here override instance-wide variables of the same name; agents see names, never values.`}
      />
      {cloud && project.remoteUrl !== null && (
        <EnvVarList
          key={`cloud-env-${project.id}`}
          cloud
          scope="project"
          projectId={project.id}
          intro={`Injected into ${project.name}'s cloud workspaces. Kept on the cloud host, apart from this Mac's values; nobody else on the host can read them.`}
        />
      )}
      <InstructionsEditor
        key={`instructions-${project.id}-${project.customPromptGeneral === null ? 'merged' : 'recovery'}`}
        scope="project"
        projectId={project.id}
        label="Project instructions"
        hint="Project guidance for new sessions. Existing sessions keep their saved instructions."
      />
    </>
  )
}

function ProjectPrompts({ project }: { project: ProjectRow }) {
  const [draft, setDraft] = useState<Prompts | null>(null)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<keyof Prompts>>(new Set())
  const push = useToasts((s) => s.push)
  const saved = projectPrompts(project)
  const values = draft ?? saved
  const dirty =
    values.general !== saved.general ||
    values.codeReview !== saved.codeReview ||
    values.fixErrors !== saved.fixErrors

  const toggle = (key: keyof Prompts) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  async function savePrompts() {
    if (saving || !dirty) return
    setSaving(true)
    try {
      await window.loom.projects.setPrompts({
        projectId: project.id,
        general: values.general.trim() === '' ? null : values.general,
        codeReview: values.codeReview.trim() || null,
        fixErrors: values.fixErrors.trim() || null
      })
      await useProjects.getState().load()
      const error = useProjects.getState().error
      if (error !== null) throw new Error(error)
      setDraft(null)
      push(`Prompts saved for ${project.name}`)
    } catch (err) {
      push(`Could not update prompts for ${project.name}: ${String(err)}`, 'err')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-section" aria-label={`Prompts for ${project.name}`}>
      <p className="settings-note">Leave a prompt empty to use its built-in default.</p>
      <div className="settings-list prompt-panels">
        {FLOWS.filter((flow) => flow.key !== 'general' || project.customPromptGeneral !== null).map(
          (flow) => {
            const expanded = open.has(flow.key)
            const bodyId = `prompt-${project.id}-${flow.key}`
            return (
              <div key={flow.key} className="prompt-panel">
                <button
                  type="button"
                  className="settings-row prompt-panel-head"
                  aria-expanded={expanded}
                  aria-controls={bodyId}
                  onClick={() => toggle(flow.key)}
                >
                  <span className="settings-provider">
                    <span className="prompt-panel-title">{flow.title}</span>
                    <span className="settings-state">{flow.description}</span>
                  </span>
                  <span className="dropdown-caret prompt-panel-caret" aria-hidden="true" />
                </button>
                {expanded && (
                  <div id={bodyId} className="prompt-panel-body">
                    <textarea
                      className="input"
                      rows={flow.rows}
                      maxLength={8000}
                      aria-label={`${flow.title} instructions`}
                      placeholder={flow.placeholder}
                      value={values[flow.key]}
                      disabled={saving}
                      onChange={(e) => setDraft({ ...values, [flow.key]: e.target.value })}
                    />
                  </div>
                )}
              </div>
            )
          }
        )}
      </div>
      <div className="project-prompts-footer">
        <button
          type="button"
          className="btn btn-primary project-prompts-save"
          disabled={!dirty || saving}
          aria-label={`${saving ? 'Saving' : 'Save'} prompts for ${project.name}${dirty ? ', unsaved changes' : ''}`}
          aria-busy={saving}
          onClick={() => void savePrompts()}
        >
          <span className="project-prompts-dirty" data-dirty={dirty} aria-hidden="true" />
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  )
}
