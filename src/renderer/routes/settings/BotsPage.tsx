import { useCallback, useEffect, useRef, useState } from 'react'
import {
  botConfigSchema,
  robotConfig,
  type BotAccess,
  type BotConfig,
  type BotGrant,
  type BotInvocation,
  type BotRecord
} from '../../../shared/bots'
import type { AgentLogins } from '../../../shared/ipc-contract'
import type { SubscriptionAccess, SubscriptionProvider } from '../../../shared/subscriptions'
import { EFFORTS, type Effort } from '../../../shared/models'
import { supportsBots, supportsSubscriptions } from '../../../shared/runner-capabilities'
import type { OrgMember } from '../../../shared/org'
import { Dropdown } from '../../components/ui/Dropdown'
import { Field } from '../../components/ui/Field'
import { useToasts } from '../../components/ui/Toast'
import { useCloud } from '../../state/cloud'
import { useOrganization } from '../../state/organization'
import { useFiles } from '../../state/files'
import { useProjects } from '../../state/projects'
import { useSessions } from '../../state/sessions'
import { useUi } from '../../state/ui'

const failure = (cause: unknown) => String(cause).replace(/^Error: /, '')
const PHASES = {
  preparing: 'Preparing workspace',
  ready: 'Conversation opened',
  failed: 'Launch failed',
  interrupted: 'Interrupted — review before continuing'
}

/** Access changes apply while conversations are open, including when Settings is unmounted. */
export function watchBotAccess(): () => void {
  let generation = 0
  let disposed = false
  function forget(ids: string[]): void {
    if (ids.length === 0) return
    const removed = new Set(ids)
    const sessionIds = new Set(
      ids.flatMap((id) => (useSessions.getState().sessionsByWorkspace[id] ?? []).map((session) => session.id))
    )
    useUi.setState((state) => ({
      draftBySession: Object.fromEntries(
        Object.entries(state.draftBySession).filter(
          ([id]) => !sessionIds.has(id) && !ids.some((workspaceId) => id === `new:${workspaceId}`)
        )
      ),
      attachmentsBySession: Object.fromEntries(
        Object.entries(state.attachmentsBySession).filter(([id]) => !sessionIds.has(id))
      ),
      questionDrafts: Object.fromEntries(
        Object.entries(state.questionDrafts).filter(
          ([key]) => ![...sessionIds].some((id) => key.startsWith(`${id}:`))
        )
      )
    }))
    useSessions.getState().forgetWorkspaces(ids)
    useFiles.getState().forgetWorkspaces(ids)
    useProjects.setState((state) => {
      const workspacesByProject = Object.fromEntries(
        Object.entries(state.workspacesByProject).map(([id, rows]) => [
          id,
          rows.filter((row) => !removed.has(row.id))
        ])
      )
      return {
        workspacesByProject,
        projects: state.projects.filter(
          (project) =>
            !project.id.startsWith('loom-bot-project:') || (workspacesByProject[project.id]?.length ?? 0) > 0
        )
      }
    })
    const route = useUi.getState().route
    if (route.name === 'workspace' && removed.has(route.workspaceId))
      useUi.getState().navigate({ name: 'home' })
  }
  function botWorkspaces() {
    return Object.values(useProjects.getState().workspacesByProject)
      .flat()
      .filter((row) => row.bot !== undefined)
  }
  async function refresh(): Promise<void> {
    const mine = ++generation
    const affected = botWorkspaces()
    const status = useCloud.getState().status
    if (status.state !== 'connected' || !supportsBots(status.capabilities)) {
      forget(affected.map((workspace) => workspace.id))
      return
    }
    if (affected.length === 0) return
    try {
      const bots = await window.loom.bots.list()
      if (disposed || mine !== generation) return
      const access = new Map(
        bots.map((bot) => [bot.id, bot.access === null ? null : bot.enabled ? bot.access : ('view' as const)])
      )
      const revoked = affected
        .filter((workspace) => !access.get(workspace.bot!.id))
        .map((workspace) => workspace.id)
      forget(revoked)
      const changed = affected.filter(
        (workspace) =>
          access.get(workspace.bot!.id) && access.get(workspace.bot!.id) !== workspace.bot!.access
      )
      if (changed.length > 0) {
        const ids = changed.map((workspace) => workspace.id)
        useSessions.getState().forgetWorkspaces(ids)
        useFiles.getState().forgetWorkspaces(ids)
        useProjects.setState((state) => ({
          workspacesByProject: Object.fromEntries(
            Object.entries(state.workspacesByProject).map(([id, rows]) => [
              id,
              rows.map((workspace) =>
                workspace.bot && access.get(workspace.bot.id)
                  ? { ...workspace, bot: { ...workspace.bot, access: access.get(workspace.bot.id)! } }
                  : workspace
              )
            ])
          )
        }))
        for (const id of ids)
          void Promise.all([useSessions.getState().load(id), useFiles.getState().loadTree(id)]).catch(
            () => {}
          )
      }
      const projects = new Set(
        affected.filter((workspace) => access.get(workspace.bot!.id)).map((workspace) => workspace.projectId)
      )
      // A later grant change may invalidate these reads; its own refresh owns the new state.
      await Promise.allSettled(
        [...projects].map((projectId) => useProjects.getState().loadWorkspaces(projectId))
      )
    } catch {
      if (!disposed && mine === generation) forget(affected.map((workspace) => workspace.id))
    }
  }
  const botsChanged = window.loom.onBotsChanged(() => void refresh())
  const cloudChanged = useCloud.subscribe((next, previous) => {
    const available = next.status.state === 'connected' && supportsBots(next.status.capabilities)
    const wasAvailable = previous.status.state === 'connected' && supportsBots(previous.status.capabilities)
    if (next.status.state === previous.status.state && available === wasAvailable) return
    generation++
    if (!available) forget(botWorkspaces().map((workspace) => workspace.id))
    else void refresh()
  })
  return () => {
    disposed = true
    generation++
    botsChanged()
    cloudChanged()
  }
}

export function BotsPage() {
  const status = useCloud((state) => state.status)
  const connected = status.state === 'connected'
  const botsAvailable = connected && supportsBots(status.capabilities)
  const overview = useOrganization((state) => state.overview)
  const connection = useOrganization((state) => state.connection)
  const owner = overview?.role === 'owner'
  const [bots, setBots] = useState<BotRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const listing = useRef(0)
  const reload = useCallback(async () => {
    const mine = generation.current
    const list = ++listing.current
    try {
      const next = await window.loom.bots.list()
      if (mine !== generation.current || list !== listing.current) return
      setBots(next)
      setError(null)
      setLoading(false)
    } catch (cause) {
      if (mine === generation.current && list === listing.current) {
        setError(failure(cause))
        setLoading(false)
      }
    }
  }, [])
  useEffect(() => {
    generation.current++
    setBots([])
    setSelectedId(null)
    setCreating(false)
    setError(null)
    setLoading(botsAvailable)
    if (!botsAvailable || overview === null) return
    void reload()
    const unsubscribe = window.loom.onBotsChanged(() => void reload())
    return () => {
      generation.current++
      unsubscribe()
    }
  }, [botsAvailable, connection, overview?.role, reload])
  const selected = bots.find((bot) => bot.id === selectedId) ?? bots[0]

  if (connected && !botsAvailable)
    return (
      <p className="settings-note">
        Ask your operator to update the runner to use bots. Your personal cloud workspaces are still
        available.
      </p>
    )
  if (!connected || overview === null)
    return <p className="settings-note">Connect to your organization under Cloud settings to use bots.</p>
  return (
    <>
      <section className="settings-section">
        <div className="row">
          <div className="settings-label grow">Organization bots</div>
          <button className="btn btn-ghost" onClick={() => void reload()}>
            Refresh
          </button>
          {owner && (
            <button className="btn" onClick={() => setCreating(true)}>
              Create bot
            </button>
          )}
        </div>
        {error && (
          <p className="connection-error" role="alert">
            {error}
          </p>
        )}
        {loading && (
          <p className="settings-note" role="status">
            Loading bots…
          </p>
        )}
        {!loading && bots.length === 0 && (
          <p className="settings-note">No bots are available. An owner can create a bot and grant access.</p>
        )}
        <div className="settings-list">
          {bots.map((bot) => (
            <div className="settings-row" key={bot.id}>
              <button
                type="button"
                className="btn btn-ghost grow bot-choice"
                aria-pressed={!creating && selected?.id === bot.id}
                onClick={() => {
                  setSelectedId(bot.id)
                  setCreating(false)
                }}
              >
                {bot.config.name}
              </button>
              <span className="settings-state">
                {bot.enabled ? 'Enabled' : 'Disabled'} ·{' '}
                {bot.access === 'control'
                  ? 'Control'
                  : bot.access === 'view'
                    ? 'View only'
                    : 'Administration only'}
              </span>
            </div>
          ))}
        </div>
      </section>
      {creating && owner ? (
        <BotEditor
          key={`create:${connection}`}
          onSaved={(bot) => {
            setSelectedId(bot.id)
            setCreating(false)
            void reload()
          }}
          onCancel={() => setCreating(false)}
        />
      ) : (
        selected && (
          <BotDetails key={`${selected.id}:${connection}`} bot={selected} owner={owner} onChanged={reload} />
        )
      )}
    </>
  )
}

function BotEditor({
  bot,
  onSaved,
  onCancel
}: {
  bot?: BotRecord
  onSaved(bot: BotRecord): void
  onCancel?: () => void
}) {
  const [config, setConfig] = useState<BotConfig>(
    () => bot?.config ?? { ...robotConfig(), name: '', instructions: '' }
  )
  const [slug, setSlug] = useState(bot?.slug ?? '')
  const [repositories, setRepositories] = useState(bot?.config.repositories.join('\n') ?? '')
  const [enabled, setEnabled] = useState(bot?.enabled ?? true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const alive = useRef(true)
  const models = useSessions((state) => state.modelsByBackend[config.backend]) ?? []
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    void useSessions.getState().loadModels(config.backend)
  }, [config.backend])
  const patch = (change: Partial<BotConfig>) => setConfig((value) => ({ ...value, ...change }))
  function chooseModel(backend: BotConfig['backend'], model: string, preferred = config.effort) {
    const supported = useSessions
      .getState()
      .modelsByBackend[backend]?.find((entry) => entry.id === model)?.efforts
    const effort =
      supported && !supported.includes(preferred)
        ? supported.includes('xhigh')
          ? 'xhigh'
          : (supported[0] ?? 'high')
        : preferred
    patch({ backend, model, effort })
  }
  async function submit() {
    if (submitting.current) return
    const parsed = botConfigSchema.safeParse({
      ...config,
      repositories: repositories
        .split(/[,\n]/)
        .map((value) => value.trim())
        .filter(Boolean)
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the bot configuration.')
      return
    }
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const saved = bot
        ? await window.loom.bots.update(bot.id, parsed.data, enabled, bot.revision)
        : await window.loom.bots.create(slug, parsed.data)
      if (alive.current) onSaved(saved)
    } catch (cause) {
      if (alive.current) setError(failure(cause))
    } finally {
      if (alive.current) {
        submitting.current = false
        setBusy(false)
      }
    }
  }
  return (
    <section className="settings-section">
      <div className="row">
        <div className="settings-label grow">
          {bot ? `Configuration · revision ${bot.revision}` : 'Create a bot'}
        </div>
        {!bot && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => {
              setSlug('robot')
              setConfig(robotConfig())
              setRepositories('')
              setError(null)
            }}
          >
            Use Robot template
          </button>
        )}
      </div>
      <form
        className="settings-form bot-form"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <fieldset disabled={busy}>
          {!bot && (
            <Field label="Bot name in links" hint="Lowercase letters, numbers, and hyphens.">
              <input
                className="input"
                value={slug}
                required
                maxLength={48}
                pattern="[a-z][a-z0-9-]{0,47}"
                onChange={(event) => setSlug(event.target.value)}
                placeholder="robot"
              />
            </Field>
          )}
          <Field label="Display name">
            <input
              className="input"
              value={config.name}
              required
              maxLength={80}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </Field>
          <Field
            label="Instructions"
            hint="Versioned instructions owned by the bot. Never include passwords or tokens."
          >
            <textarea
              className="input"
              rows={7}
              value={config.instructions}
              required
              maxLength={16000}
              onChange={(event) => patch({ instructions: event.target.value })}
            />
          </Field>
          <Field
            label="Repositories"
            hint="One GitHub owner/repository per line. Installation credentials support one owner."
          >
            <textarea
              className="input mono"
              rows={3}
              value={repositories}
              required
              maxLength={16384}
              onChange={(event) => setRepositories(event.target.value)}
              placeholder="your-org/your-repo"
            />
          </Field>
          <Field label="Provider">
            <Dropdown
              value={config.backend}
              options={[
                { value: 'codex', label: 'Codex' },
                { value: 'claude', label: 'Claude' }
              ]}
              onChange={(value) =>
                chooseModel(
                  value as BotConfig['backend'],
                  value === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol',
                  value === 'claude' ? 'xhigh' : config.effort === 'minimal' ? 'high' : config.effort
                )
              }
            />
          </Field>
          <Field label="Model">
            <Dropdown
              value={config.model}
              options={[
                ...models.map((model) => ({ value: model.id, label: model.label })),
                ...(models.some((model) => model.id === config.model)
                  ? []
                  : [{ value: config.model, label: config.model }])
              ]}
              onChange={(model) => chooseModel(config.backend, model)}
            />
          </Field>
          <Field label="Effort">
            <Dropdown
              value={config.effort}
              options={(
                models.find((model) => model.id === config.model)?.efforts ??
                EFFORTS.filter(
                  (effort) => effort !== 'minimal' && (config.backend === 'codex' || effort !== 'ultra')
                )
              ).map((effort) => ({ value: effort, label: effort }))}
              onChange={(effort) => patch({ effort: effort as Effort })}
            />
          </Field>
          <Field label="Claude permissions">
            <Dropdown
              value={config.modes.claude}
              options={[
                { value: 'auto', label: 'Review actions automatically' },
                { value: 'bypass', label: 'Allow actions without asking' }
              ]}
              onChange={(value) =>
                patch({ modes: { ...config.modes, claude: value as BotConfig['modes']['claude'] } })
              }
            />
          </Field>
          <Field label="Codex permissions">
            <Dropdown
              value={config.modes.codex}
              options={[
                { value: 'sandbox', label: 'Workspace sandbox' },
                { value: 'bypass', label: 'Allow actions without asking' }
              ]}
              onChange={(value) =>
                patch({ modes: { ...config.modes, codex: value as BotConfig['modes']['codex'] } })
              }
            />
          </Field>
          <div className="row">
            <span className="settings-label grow">Skills</span>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={config.skills.length >= 16}
              onClick={() => patch({ skills: [...config.skills, { name: '', instructions: '' }] })}
            >
              Add skill
            </button>
          </div>
          {config.skills.map((skill, index) => (
            <div className="bot-skill" key={index}>
              <Field label={`Skill ${index + 1} name`}>
                <input
                  className="input"
                  required
                  value={skill.name}
                  maxLength={64}
                  pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"
                  onChange={(event) =>
                    patch({
                      skills: config.skills.map((item, at) =>
                        at === index ? { ...item, name: event.target.value } : item
                      )
                    })
                  }
                />
              </Field>
              <Field label="Skill instructions">
                <textarea
                  className="input"
                  required
                  rows={4}
                  value={skill.instructions}
                  maxLength={8000}
                  onChange={(event) =>
                    patch({
                      skills: config.skills.map((item, at) =>
                        at === index ? { ...item, instructions: event.target.value } : item
                      )
                    })
                  }
                />
              </Field>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => patch({ skills: config.skills.filter((_, at) => at !== index) })}
              >
                Remove skill
              </button>
            </div>
          ))}
          {bot && (
            <label className="row">
              <input
                className="preferences-toggle"
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              Enabled
            </label>
          )}
          <p className="settings-note">
            Existing conversations keep their original instructions and skills. Current access and credential
            grants still apply.
          </p>
          <div className="row">
            <button className="btn" type="submit">
              {busy ? 'Saving…' : bot ? 'Save configuration' : 'Create bot'}
            </button>
            {onCancel && (
              <button className="btn btn-ghost" type="button" onClick={onCancel}>
                Cancel
              </button>
            )}
          </div>
        </fieldset>
        {error && (
          <p className="connection-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  )
}

function BotDetails({
  bot,
  owner,
  onChanged
}: {
  bot: BotRecord
  owner: boolean
  onChanged(): Promise<void>
}) {
  return (
    <>
      {bot.access !== null ? (
        <BotWork bot={bot} />
      ) : (
        <section className="settings-section">
          <p className="settings-note">
            Administration does not grant access to this bot’s work. Grant yourself view or control access
            below to open conversations.
          </p>
        </section>
      )}
      {owner && (
        <>
          <BotSubscriptions botId={bot.id} />
          <BotGithub botId={bot.id} />
          <BotGrants botId={bot.id} onChanged={onChanged} />
          <BotEditor key={`${bot.id}:${bot.revision}`} bot={bot} onSaved={() => void onChanged()} />
        </>
      )}
    </>
  )
}

function BotWork({ bot }: { bot: BotRecord }) {
  const [repository, setRepository] = useState(bot.config.repositories[0] ?? '')
  const [prompt, setPrompt] = useState('')
  const [invocations, setInvocations] = useState<BotInvocation[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef<{ input: string; key: string } | null>(null)
  const submitting = useRef(false)
  const generation = useRef(0)
  const listing = useRef(0)
  const push = useToasts((state) => state.push)
  const refresh = useCallback(async () => {
    const mine = generation.current
    const asked = ++listing.current
    try {
      const records = await window.loom.bots.invocations(bot.id)
      if (mine === generation.current && asked === listing.current) {
        setInvocations(records.slice(0, 100))
        setLoadError(null)
      }
    } catch (cause) {
      if (mine === generation.current && asked === listing.current) setLoadError(failure(cause))
    }
  }, [bot.id])
  useEffect(() => {
    generation.current++
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    const unsubscribe = window.loom.onBotsChanged(({ botId }) => {
      if (botId === bot.id) void refresh()
    })
    return () => {
      generation.current++
      clearInterval(timer)
      unsubscribe()
    }
  }, [bot.id, refresh])
  useEffect(() => {
    if (!bot.config.repositories.includes(repository)) setRepository(bot.config.repositories[0] ?? '')
  }, [bot.config.repositories, repository])
  async function invoke() {
    if (submitting.current) return
    const input = JSON.stringify([bot.id, repository, prompt.trim()])
    if (pending.current?.input !== input) pending.current = { input, key: crypto.randomUUID() }
    const requestKey = pending.current.key
    const mine = generation.current
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const accepted = await window.loom.bots.invoke(bot.id, repository, prompt.trim(), requestKey)
      if (mine !== generation.current) return
      setInvocations((rows) => [accepted, ...rows.filter((row) => row.id !== accepted.id)].slice(0, 100))
      setPrompt('')
      pending.current = null
    } catch (cause) {
      if (mine === generation.current) setError(failure(cause))
    } finally {
      if (mine === generation.current) {
        submitting.current = false
        setBusy(false)
      }
    }
  }
  async function open(invocationId: string) {
    const mine = generation.current
    try {
      const result = await window.loom.bots.open(invocationId)
      if (mine !== generation.current) return
      if (!result.project || !result.workspace) {
        setError(result.invocation.error ?? 'The workspace is still preparing. Refresh and try again.')
        return
      }
      const { project, workspace, session } = result
      useProjects.setState((state) => ({
        projects: [...state.projects.filter((row) => row.id !== project.id), project],
        workspacesByProject: {
          ...state.workspacesByProject,
          [project.id]: [
            ...(state.workspacesByProject[project.id] ?? []).filter((row) => row.id !== workspace.id),
            workspace
          ]
        }
      }))
      await useSessions.getState().load(workspace.id)
      if (mine !== generation.current) return
      if (session) useSessions.getState().setActive(workspace.id, session.id)
      useUi.getState().navigate({ name: 'workspace', workspaceId: workspace.id })
    } catch (cause) {
      if (mine === generation.current) push(failure(cause), 'err')
    }
  }
  return (
    <>
      <section className="settings-section">
        <div className="settings-label">Ask {bot.config.name}</div>
        {bot.access === 'control' ? (
          <form
            className="settings-form bot-form"
            onSubmit={(event) => {
              event.preventDefault()
              void invoke()
            }}
          >
            <fieldset disabled={busy || !bot.enabled}>
              <Field label="Repository">
                <Dropdown
                  value={repository}
                  options={bot.config.repositories.map((value) => ({ value, label: value }))}
                  onChange={setRepository}
                />
              </Field>
              <Field label="Request">
                <textarea
                  className="input"
                  rows={4}
                  value={prompt}
                  required
                  maxLength={32000}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Describe the work and the result you need."
                />
              </Field>
              <button className="btn" disabled={prompt.trim() === '' || repository === ''}>
                {busy ? 'Starting…' : 'Start conversation'}
              </button>
            </fieldset>
          </form>
        ) : (
          <p className="settings-note">
            You can view this bot’s work. Control access is required to invoke it.
          </p>
        )}
        {!bot.enabled && (
          <p className="settings-note">
            This bot is disabled. Its retained conversations remain available to permitted members.
          </p>
        )}
        {error && (
          <p className="connection-error" role="alert">
            {error}
          </p>
        )}
      </section>
      <section className="settings-section">
        <div className="row">
          <div className="settings-label grow">Conversations</div>
          <button className="btn btn-ghost" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        <p className="settings-note">
          “Conversation opened” means the workspace was launched. Read the conversation for progress and
          results.
        </p>
        {loadError && (
          <p className="connection-error" role="alert">
            {loadError}
          </p>
        )}
        {invocations.length === 0 && <p className="settings-note">No conversations yet.</p>}
        <div className="settings-list">
          {invocations.map((invocation) => (
            <div className="settings-row bot-invocation" key={invocation.id}>
              <div className="settings-provider">
                <span className="settings-name">{invocation.repository}</span>
                <span className="bot-request">{invocation.prompt}</span>
                <span className="settings-state">
                  {PHASES[invocation.state]} · {new Date(invocation.createdAt).toLocaleString()}
                </span>
                {invocation.error && <span className="connection-error">{invocation.error}</span>}
              </div>
              <button className="btn btn-ghost" type="button" onClick={() => void open(invocation.id)}>
                Open workspace
              </button>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}

function BotSubscriptions({ botId }: { botId: string }) {
  const status = useCloud((state) => state.status)
  const available = status.state === 'connected' && supportsSubscriptions(status.capabilities)
  const [access, setAccess] = useState<SubscriptionAccess | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const listing = useRef(0)
  const submitting = useRef(false)
  const refresh = useCallback(async () => {
    const mine = generation.current
    const asked = ++listing.current
    try {
      const next = await window.loom.subscriptions.grants(botId)
      if (mine === generation.current && asked === listing.current) {
        setAccess(next)
        setError(null)
      }
    } catch (cause) {
      if (mine === generation.current && asked === listing.current) setError(failure(cause))
    }
  }, [botId])
  useEffect(() => {
    generation.current++
    setAccess(null)
    setError(null)
    setBusy(false)
    submitting.current = false
    if (!available) return
    void refresh()
    const unsubscribe = window.loom.onBotsChanged((push) => {
      if (push.botId === botId) void refresh()
    })
    return () => {
      generation.current++
      unsubscribe()
    }
  }, [available, botId, refresh])
  async function change(provider: SubscriptionProvider, allowed: boolean) {
    if (submitting.current) return
    const mine = generation.current
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      await window.loom.subscriptions.setGrant(botId, provider, allowed)
      if (mine === generation.current) await refresh()
    } catch (cause) {
      if (mine === generation.current) setError(failure(cause))
    } finally {
      if (mine === generation.current) {
        submitting.current = false
        setBusy(false)
      }
    }
  }
  return (
    <section className="settings-section">
      <div className="row">
        <div className="settings-label grow">Organization subscriptions</div>
        {available && (
          <button
            className="btn btn-ghost"
            onClick={() => useUi.getState().navigate({ name: 'settings', page: 'org-subscriptions' })}
          >
            Manage subscriptions
          </button>
        )}
      </div>
      <p className="settings-note">
        Grant this bot access to the organization’s provider pools. Each conversation retains its selected
        account.
      </p>
      {available ? (
        <fieldset className="bot-grants" disabled={busy || access === null}>
          {(['claude', 'codex'] as const).map((provider) => (
            <label className="row" key={provider}>
              <input
                className="preferences-toggle"
                type="checkbox"
                checked={access?.[provider] ?? false}
                onChange={(event) => void change(provider, event.target.checked)}
              />
              {provider === 'claude' ? 'Claude subscription pool' : 'Codex subscription pool'}
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="settings-note">Ask your operator to update the runner to grant subscription access.</p>
      )}
      {error && (
        <p className="connection-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function BotGithub({ botId }: { botId: string }) {
  const [logins, setLogins] = useState<AgentLogins | null>(null)
  const [appId, setAppId] = useState('')
  const [installationId, setInstallationId] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const listing = useRef(0)
  const submitting = useRef(false)
  const refresh = useCallback(async () => {
    const mine = generation.current
    const asked = ++listing.current
    try {
      const status = await window.loom.bots.logins(botId)
      if (mine === generation.current && asked === listing.current) {
        setLogins(status)
      }
    } catch (cause) {
      if (mine === generation.current && asked === listing.current) setError(failure(cause))
    }
  }, [botId])
  useEffect(() => {
    generation.current++
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    return () => {
      generation.current++
      clearInterval(timer)
    }
  }, [refresh])
  async function act(operation: () => Promise<unknown>) {
    if (submitting.current) return
    const mine = generation.current
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
      if (mine === generation.current) {
        await refresh()
      }
    } catch (cause) {
      if (mine === generation.current) setError(failure(cause))
    } finally {
      if (mine === generation.current) {
        submitting.current = false
        setBusy(false)
      }
    }
  }
  return (
    <section className="settings-section">
      <div className="settings-label">Bot GitHub installation</div>
      <p className="settings-note">
        Connect this bot’s GitHub installation. Repository tokens stay outside its workspaces.
      </p>
      <div className="settings-list">
        <div className="settings-row">
          <div className="settings-provider">
            <span className="settings-name">GitHub</span>
            <span className="settings-state">
              {logins === null ? 'Checking…' : logins.github ? 'Connected' : 'Not connected'}
              {logins?.githubApp?.account ? ` · ${logins.githubApp.account}` : ''}
            </span>
          </div>
          <button
            className="btn btn-ghost"
            disabled={busy || !(logins?.github || logins?.githubApp?.configured)}
            onClick={() => void act(() => window.loom.bots.disconnect(botId, 'github'))}
          >
            Disconnect
          </button>
        </div>
      </div>
      <form
        className="settings-form bot-form"
        onSubmit={(event) => {
          event.preventDefault()
          const credentials = { appId, installationId, privateKey }
          setAppId('')
          setInstallationId('')
          setPrivateKey('')
          void act(() => window.loom.bots.setGithub(botId, credentials))
        }}
      >
        <fieldset disabled={busy}>
          <Field label="GitHub App ID">
            <input
              className="input mono"
              required
              inputMode="numeric"
              pattern="[1-9][0-9]{0,19}"
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="GitHub installation ID">
            <input
              className="input mono"
              required
              inputMode="numeric"
              pattern="[1-9][0-9]{0,19}"
              value={installationId}
              onChange={(event) => setInstallationId(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field
            label="GitHub App private key"
            hint="Stored encrypted on the runner. Repository tokens stay outside workspaces."
          >
            <textarea
              className="input mono"
              required
              rows={3}
              autoComplete="off"
              spellCheck={false}
              value={privateKey}
              maxLength={32768}
              onChange={(event) => setPrivateKey(event.target.value)}
            />
          </Field>
          <button className="btn" disabled={!appId || !installationId || !privateKey}>
            Save GitHub installation
          </button>
        </fieldset>
      </form>
      {error && (
        <p className="connection-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function BotGrants({ botId, onChanged }: { botId: string; onChanged(): Promise<void> }) {
  const [members, setMembers] = useState<OrgMember[]>([])
  const [grants, setGrants] = useState<BotGrant[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const listing = useRef(0)
  const submitting = useRef(false)
  const refresh = useCallback(async () => {
    const mine = generation.current
    const asked = ++listing.current
    try {
      const [people, access] = await Promise.all([window.loom.org.members(), window.loom.bots.grants(botId)])
      if (mine === generation.current && asked === listing.current) {
        setMembers(people.filter((person) => person.kind === 'human' && person.state === 'active'))
        setGrants(access)
      }
    } catch (cause) {
      if (mine === generation.current && asked === listing.current) setError(failure(cause))
    }
  }, [botId])
  useEffect(() => {
    generation.current++
    void refresh()
    const unsubscribe = window.loom.onBotsChanged((push) => {
      if (push.botId === botId) void refresh()
    })
    return () => {
      generation.current++
      unsubscribe()
    }
  }, [refresh])
  async function change(userId: string, value: string) {
    if (submitting.current) return
    submitting.current = true
    const mine = generation.current
    setBusy(true)
    setError(null)
    try {
      await window.loom.bots.setGrant(botId, userId, value === '' ? null : (value as BotAccess))
      if (mine === generation.current) {
        await refresh()
        await onChanged()
      }
    } catch (cause) {
      if (mine === generation.current) setError(failure(cause))
    } finally {
      if (mine === generation.current) {
        submitting.current = false
        setBusy(false)
      }
    }
  }
  return (
    <section className="settings-section">
      <div className="settings-label">Human access</div>
      <p className="settings-note">
        View allows inspection. Control also allows requests, workspace execution, and use of the bot’s
        granted capabilities.
      </p>
      <fieldset className="bot-grants" disabled={busy}>
        {members.map((person) => (
          <div className="settings-row" key={person.userId}>
            <span className="settings-provider">{person.email}</span>
            <Dropdown
              value={grants.find((grant) => grant.userId === person.userId)?.access ?? ''}
              options={[
                { value: '', label: 'No access' },
                { value: 'view', label: 'View only' },
                { value: 'control', label: 'Control' }
              ]}
              onChange={(value) => void change(person.userId, value)}
            />
          </div>
        ))}
      </fieldset>
      {error && (
        <p className="connection-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
