import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { botConfigSchema, type BotConfig, type BotInvocation } from '../../shared/bots'
import type { ProjectRow } from '../../shared/ipc-contract'
import { MAX_SESSION_INSTRUCTION_CHARS } from '../../shared/limits'
import { getWorkspace } from '../db/repos/workspaces'
import { contextText } from '../context/materialize'
import { slugify } from '../git/slug'
import { composeInstructions } from '../instructions/compose'
import type { RunnerAdmission } from '../runner/admission'
import { contain } from '../security/contain'
import { createSession, sendTurn } from '../sessions/service'
import { createWorkspace, waitForWorkspaceSettled } from '../workspace/bootstrap'

interface ExecutionOptions {
  db: Database.Database
  dataRoot: string
  admission: RunnerAdmission
  projectFor(repository: string): ProjectRow | Promise<ProjectRow>
  credentialsReady(botId: string, config: BotConfig, workspaceId: string): Promise<void>
  /** Runtime seams keep isolated acceptance tests independent of Docker and provider accounts. */
  operations?: {
    createWorkspace?: typeof createWorkspace
    waitForWorkspaceSettled?: typeof waitForWorkspaceSettled
    sendTurn?: typeof sendTurn
  }
}

export function compileBotInstructions(config: BotConfig): string {
  const instructions = [
    `# Bot instructions for ${config.name}\n\n${config.instructions}`,
    ...config.skills.map((skill) => `# Skill ${skill.name}\n\n${skill.instructions}`)
  ].join('\n\n')
  const snapshot = composeInstructions({
    repositoryInstructions: [],
    overlay: [],
    general: instructions,
    envNames: [],
    container: true
  })
  if (snapshot.length > MAX_SESSION_INSTRUCTION_CHARS)
    throw new Error('Bot instructions and skills exceed the session instruction limit')
  return snapshot
}

/** Refuse every symlink component, including links that happen to point back inside the checkout. */
async function bundleDirectory(root: string, relative: string, assertCurrent: () => void): Promise<string> {
  let walked = ''
  for (const component of relative.split(path.sep)) {
    assertCurrent()
    walked = path.join(walked, component)
    const target = await contain(root, walked)
    assertCurrent()
    const absolute = path.join(root, walked)
    const existing = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (existing !== null && (!existing.isDirectory() || existing.isSymbolicLink()))
      throw new Error('Bot skill directory must not contain a symlink or non-directory')
    assertCurrent()
    if (existing === null) await mkdir(target, { mode: 0o700 })
  }
  assertCurrent()
  return contain(root, relative)
}

async function bundleFile(
  root: string,
  relative: string,
  text: string,
  assertCurrent: () => void
): Promise<void> {
  await bundleDirectory(root, path.dirname(relative), assertCurrent)
  assertCurrent()
  const leaf = await lstat(path.join(root, relative)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (leaf !== null && (!leaf.isFile() || leaf.isSymbolicLink()))
    throw new Error('Bot skill file must not be a symlink or non-file')
  const target = await contain(root, relative)
  assertCurrent()
  let handle
  try {
    handle = await open(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o400
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!(await existing.stat()).isFile() || (await existing.readFile('utf8')) !== text)
        throw new Error('Existing bot skill snapshot differs; inspect the workspace before continuing')
    } finally {
      await existing.close()
    }
    assertCurrent()
    return
  }
  try {
    assertCurrent()
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  assertCurrent()
  await contain(root, relative)
}

async function materializeBundle(
  invocation: BotInvocation,
  root: string,
  assertCurrent: () => void
): Promise<void> {
  if (!Number.isSafeInteger(invocation.configRevision) || invocation.configRevision < 1)
    throw new Error('Bot configuration revision is invalid')
  const rootReal = await realpath(root)
  const directory = path.join('.context', 'loombot', String(invocation.configRevision))
  const digest = (text: string) => createHash('sha256').update(text).digest('hex')
  for (const skill of invocation.config.skills) {
    await bundleFile(
      rootReal,
      path.join(directory, 'skills', skill.name, 'SKILL.md'),
      skill.instructions,
      assertCurrent
    )
  }
  await bundleFile(
    rootReal,
    path.join(directory, 'manifest.json'),
    JSON.stringify(
      {
        botId: invocation.botId,
        revision: invocation.configRevision,
        configurationDigest: digest(JSON.stringify(invocation.config)),
        skills: invocation.config.skills.map((skill) => ({
          name: skill.name,
          digest: digest(skill.instructions)
        }))
      },
      null,
      2
    ),
    assertCurrent
  )
}

/** Bot admission composes existing workspace/session services; it owns no separate provider lifecycle. */
export function createBotExecution(options: ExecutionOptions) {
  const { db } = options
  const create = options.operations?.createWorkspace ?? createWorkspace
  const settle = options.operations?.waitForWorkspaceSettled ?? waitForWorkspaceSettled
  const send = options.operations?.sendTurn ?? sendTurn
  return {
    async provision(invocation: BotInvocation, assertCurrent: () => void): Promise<void> {
      assertCurrent()
      const config = botConfigSchema.parse(invocation.config)
      if (!config.repositories.includes(invocation.repository))
        throw new Error('Repository is outside this bot snapshot')
      const snapshot = compileBotInstructions(config)
      if (db.prepare('SELECT id FROM sessions WHERE id=?').get(invocation.sessionId) !== undefined)
        throw new Error('This invocation already has a conversation; inspect it before explicitly continuing')
      await options.credentialsReady(invocation.botId, config, invocation.workspaceId)
      assertCurrent()
      const project = await options.projectFor(invocation.repository)
      assertCurrent()
      const existing = getWorkspace(db, invocation.workspaceId)
      if (existing !== null) {
        if (existing.ownerId !== invocation.botId)
          throw new Error('Reserved workspace identity does not belong to this bot invocation')
        throw new Error(
          'Reserved workspace already exists; inspect retained work before explicitly continuing'
        )
      }
      let workspace = await options.admission.create(invocation.botId, () => {
        assertCurrent()
        return create({
          db,
          dataRoot: options.dataRoot,
          id: invocation.workspaceId,
          projectId: project.id,
          name: `${slugify(config.name).slice(0, 36)}-${invocation.id.slice(0, 8)}`,
          checkout: 'clone',
          runtime: 'container',
          ownerId: invocation.botId,
          modes: config.modes,
          beforeInsert: assertCurrent,
          async prepareWorkspace(prepared) {
            assertCurrent()
            await materializeBundle({ ...invocation, config }, prepared.worktreePath, assertCurrent)
            assertCurrent()
            const root = await realpath(prepared.worktreePath)
            await bundleFile(
              root,
              path.join('.context', 'loom.context'),
              contextText({
                workspaceName: prepared.name,
                branch: prepared.branch,
                repoPath: prepared.worktreePath,
                backend: config.backend,
                model: config.model,
                effort: config.effort,
                at: invocation.createdAt,
                envNames: []
              }),
              assertCurrent
            )
            assertCurrent()
          }
        })
      })
      assertCurrent()
      if (
        workspace.ownerId !== invocation.botId ||
        workspace.projectId !== project.id ||
        workspace.runtime !== 'container' ||
        workspace.checkout !== 'clone'
      )
        throw new Error('Reserved workspace identity does not belong to this bot invocation')
      options.admission.assertNewWork(invocation.botId)
      assertCurrent()
      workspace = await settle(db, invocation.workspaceId)
      assertCurrent()
      if (workspace.state !== 'ready') throw new Error('Bot workspace setup failed; inspect its setup log')
      createSession(
        db,
        {
          workspaceId: invocation.workspaceId,
          backend: config.backend,
          model: config.model,
          effort: config.effort,
          title: config.name
        },
        snapshot,
        invocation.sessionId
      )
      assertCurrent()
      await send(
        db,
        invocation.sessionId,
        invocation.prompt,
        [],
        [],
        invocation.messageId,
        invocation.requesterId
      )
      assertCurrent()
    }
  }
}
