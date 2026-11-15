import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { canonicalBotRepository, type BotInvocation } from '../../shared/bots'
import type { createBotService } from './repository'

export interface BotInvokeInput {
  botId: string
  repository: string
  prompt: string
  requestKey: string
}

interface InvocationOptions {
  db: Database.Database
  bots: ReturnType<typeof createBotService>
  provision(invocation: BotInvocation, assertCurrent: () => void): Promise<void> | void
  changed?(botId: string): void
}

const COLUMNS = `id, bot_id AS botId, requester_id AS requesterId, request_key AS requestKey,
  fingerprint, config_revision AS configRevision, config, repository, prompt,
  workspace_id AS workspaceId, session_id AS sessionId, message_id AS messageId,
  state, error, created_at AS createdAt, updated_at AS updatedAt`
type Row = Omit<BotInvocation, 'config'> & { config: string }
const fromRow = (row: Row): BotInvocation => ({
  ...row,
  config: JSON.parse(row.config) as BotInvocation['config']
})

/** Durable launch records; ordinary session events remain the authority for conversational outcomes. */
export function createBotInvocations(options: InvocationOptions) {
  const { db, bots } = options
  const pending = new Set<Promise<void>>()
  let closed = false

  function read(id: string): BotInvocation {
    const row = db.prepare(`SELECT ${COLUMNS} FROM bot_invocations WHERE id = ?`).get(id) as Row | undefined
    if (row === undefined) throw new Error('Bot invocation was not found')
    return fromRow(row)
  }

  function assertCurrent(invocation: BotInvocation): void {
    if (closed || !db.open) throw new Error('The runner is shutting down')
    const bot = bots.assertControl(invocation.requesterId, invocation.botId)
    if (!bot.config.repositories.includes(invocation.repository))
      throw new Error('Repository access was revoked')
    if (read(invocation.id).state !== 'preparing') throw new Error('This invocation is no longer preparing')
  }

  function finish(id: string, state: BotInvocation['state'], error: string | null = null): void {
    if (!db.open) return
    db.prepare(
      "UPDATE bot_invocations SET state = ?, error = ?, updated_at = ? WHERE id = ? AND state = 'preparing'"
    ).run(state, error, Date.now(), id)
  }

  function start(invocation: BotInvocation): void {
    const task = Promise.resolve()
      .then(async () => {
        assertCurrent(invocation)
        await options.provision(invocation, () => assertCurrent(invocation))
        assertCurrent(invocation)
        finish(invocation.id, 'ready')
      })
      .catch((error: unknown) => {
        finish(
          invocation.id,
          closed ? 'interrupted' : 'failed',
          error instanceof Error ? error.message : 'Bot launch failed'
        )
      })
      .finally(() => {
        pending.delete(task)
        options.changed?.(invocation.botId)
      })
    pending.add(task)
  }

  return {
    invoke(actorId: string, input: BotInvokeInput): BotInvocation {
      if (closed) throw new Error('The runner is shutting down')
      const bot = bots.assertControl(actorId, input.botId)
      const repository = canonicalBotRepository(input.repository)
      if (!bot.config.repositories.includes(repository))
        throw new Error('This repository is not granted to the bot')
      const prompt = input.prompt.trim()
      if (
        prompt === '' ||
        prompt.length > 32000 ||
        input.requestKey.length === 0 ||
        input.requestKey.length > 128
      )
        throw new Error('Supply a request and a stable request key')
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([repository, prompt]))
        .digest('hex')
      const previous = db
        .prepare(
          `SELECT ${COLUMNS} FROM bot_invocations WHERE bot_id = ? AND requester_id = ? AND request_key = ?`
        )
        .get(bot.id, actorId, input.requestKey) as Row | undefined
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint)
          throw new Error('Request key conflicts with different requested work')
        return fromRow(previous)
      }
      const now = Date.now()
      const invocation: BotInvocation = {
        id: randomUUID(),
        botId: bot.id,
        requesterId: actorId,
        requestKey: input.requestKey,
        fingerprint,
        configRevision: bot.revision,
        config: bot.config,
        repository,
        prompt,
        workspaceId: randomUUID(),
        sessionId: randomUUID(),
        messageId: randomUUID(),
        state: 'preparing',
        error: null,
        createdAt: now,
        updatedAt: now
      }
      db.prepare(
        `INSERT INTO bot_invocations(id,bot_id,requester_id,request_key,fingerprint,config_revision,config,
        repository,prompt,workspace_id,session_id,message_id,state,error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        invocation.id,
        invocation.botId,
        actorId,
        input.requestKey,
        fingerprint,
        bot.revision,
        JSON.stringify(invocation.config),
        repository,
        prompt,
        invocation.workspaceId,
        invocation.sessionId,
        invocation.messageId,
        'preparing',
        null,
        now,
        now
      )
      start(invocation)
      return invocation
    },
    get(actorId: string, id: string): BotInvocation {
      const invocation = read(id)
      const bot = bots.get(actorId, invocation.botId)
      if (bot.access === null) throw new Error('Bot workspace access is required')
      return invocation
    },
    list(actorId: string, botId: string): BotInvocation[] {
      const bot = bots.get(actorId, botId)
      if (bot.access === null) return []
      return (
        db
          .prepare(
            `SELECT ${COLUMNS} FROM bot_invocations WHERE bot_id = ? ORDER BY created_at DESC LIMIT 100`
          )
          .all(botId) as Row[]
      ).map(fromRow)
    },
    recover(): void {
      db.prepare(
        `UPDATE bot_invocations SET state = 'interrupted',
        error = 'Loom restarted during launch. Inspect the workspace before explicitly continuing; nothing was re-sent.',
        updated_at = ? WHERE state = 'preparing'`
      ).run(Date.now())
    },
    interrupt(botId: string, reason: string): void {
      db.prepare(
        "UPDATE bot_invocations SET state = 'interrupted', error = ?, updated_at = ? WHERE bot_id = ? AND state = 'preparing'"
      ).run(reason, Date.now(), botId)
    },
    async idle(): Promise<void> {
      await Promise.all([...pending])
    },
    async close(): Promise<void> {
      closed = true
      // Delayed launch callbacks must settle before the runner closes SQLite.
      await Promise.all([...pending])
    }
  }
}

export type BotInvocations = ReturnType<typeof createBotInvocations>
