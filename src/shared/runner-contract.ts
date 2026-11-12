import { z } from 'zod'
import {
  ipcSchemas,
  type IpcContract,
  type ProjectRow,
  type SessionCreateInput,
  type SessionForkInput,
  type SessionRow
} from './ipc-contract'
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_INSTANCE_INSTRUCTION_CHARS,
  MAX_PROJECT_INSTRUCTION_CHARS
} from './limits'

/**
 * What a desktop and a runner must agree on. Bump this whenever this file changes, or a
 * channel the runner serves changes its input, output or meaning: a desktop and a runner
 * that disagree refuse each other with "update" instead of misbehaving.
 */
export const RUNNER_PROTOCOL = 2

export const RUNNER_PATH = '/v1/ws'

/** WebSocket close code a runner uses when the desktop speaks another protocol version. */
export const CLOSE_UPDATE_REQUIRED = 4400

/** Close code for a connection whose sign-in has ended: signed out, revoked, or off the pilot list. */
export const CLOSE_SIGNED_OUT = 4401

/** Desktop to runner. The first frame on a connection is always `hello`. */
export type ClientFrame =
  { type: 'hello'; protocol: number } | { type: 'call'; id: number; channel: string; input?: unknown }

/** Runner to desktop. Errors carry only their message, as they do across Electron's IPC. */
export type RunnerFrame =
  | { type: 'hello'; protocol: number }
  | { type: 'result'; id: number; ok: true; value?: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'push'; channel: string; payload: unknown }

export const clientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.number().int() }),
  z.object({
    type: z.literal('call'),
    id: z.number().int(),
    channel: z.string().min(1).max(64),
    input: z.unknown().optional()
  })
])

/** The user's own instruction text, sent by the desktop because the runner cannot read the Mac. */
export interface UserInstructions {
  overlay: Array<{ scope: 'instance' | 'project'; text: string }>
  general: string | null
}

/** A message's identity across retries: the runner runs each one at most once. */
type Identified<T> = T & { messageId: string }
type PromptInput = IpcContract['sessions:send']['in']

/**
 * Calls only a runner serves, and the calls it serves with more input than the window sends.
 * Every other call a runner answers is the same call, with the same checks, as in IpcContract.
 */
export interface RunnerContract {
  /** Finds or creates the project a Git remote address stands for. */
  'projects:ensure': { in: { name: string; remoteUrl: string }; out: ProjectRow }
  /** Stores a file from the Mac in the tab's workspace; returns its workspace-relative path. */
  'files:upload': { in: { sessionId: string; name: string; dataBase64: string }; out: string }

  /** Starts a GitHub connection; `callback` is where the calling desktop listens on its own machine. */
  'logins:connectGithub': { in: { callback: string }; out: { url: string } }
  /** Makes GitHub's answer the caller's login, given the claim their browser came back with. */
  'logins:finishGithub': { in: { claim: string }; out: void }

  'sessions:create': { in: SessionCreateInput & { instructions: UserInstructions }; out: SessionRow }
  'sessions:fork': { in: SessionForkInput & { instructions: UserInstructions }; out: SessionRow }
  'sessions:send': { in: Identified<PromptInput>; out: void }
  'sessions:steer': { in: Identified<PromptInput>; out: void }
  'sessions:sendNow': { in: Identified<PromptInput>; out: void }
}

const id = z.string().min(1).max(64)
const identified = z.object({ messageId: id })
const instructions = z.object({
  instructions: z.object({
    overlay: z
      .array(
        z.object({
          scope: z.enum(['instance', 'project']),
          text: z.string().max(Math.max(MAX_INSTANCE_INSTRUCTION_CHARS, MAX_PROJECT_INSTRUCTION_CHARS))
        })
      )
      .max(2),
    general: z.string().max(8000).nullable()
  })
})

export const runnerSchemas = {
  'projects:ensure': z.object({ name: z.string().min(1).max(64), remoteUrl: z.string().min(1).max(2048) }),
  'files:upload': z.object({
    sessionId: id,
    name: z.string().min(1).max(255),
    // Base64 grows a file by a third.
    dataBase64: z.string().max(Math.ceil((MAX_IMAGE_ATTACHMENT_BYTES * 4) / 3) + 4)
  }),
  'sessions:create': ipcSchemas['sessions:create'].and(instructions),
  'logins:connectGithub': z.object({ callback: z.string().min(1).max(256) }),
  'logins:finishGithub': z.object({ claim: z.string().min(1).max(256) }),
  'sessions:fork': ipcSchemas['sessions:fork'].and(instructions),
  'sessions:send': ipcSchemas['sessions:send'].and(identified),
  'sessions:steer': ipcSchemas['sessions:steer'].and(identified),
  'sessions:sendNow': ipcSchemas['sessions:sendNow'].and(identified)
} satisfies { [K in keyof RunnerContract]: z.ZodType<RunnerContract[K]['in']> }
