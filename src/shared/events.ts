import { z } from 'zod'

export const toolName = z.enum(['read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep'])
export type ToolName = z.infer<typeof toolName>

export const filePatch = z.object({
  path: z.string(),
  kind: z.enum(['create', 'modify', 'delete']),
  diff: z.string()
})
export type FilePatch = z.infer<typeof filePatch>

export const questionRequest = z.object({
  type: z.literal('question.requested'),
  requestId: z.string(),
  turnId: z.string(),
  callId: z.string().optional(),
  purpose: z.literal('approval').optional(),
  blocking: z.boolean(),
  questions: z.array(
    z.object({
      id: z.string(),
      header: z.string(),
      question: z.string(),
      options: z.array(z.object({ label: z.string(), description: z.string() })).nullish(),
      isOther: z.boolean().default(false),
      isSecret: z.boolean().default(false),
      multiSelect: z.boolean().optional()
    })
  )
})
export type QuestionRequest = z.infer<typeof questionRequest>
export const questionAnswer = z.object({
  requestId: z.string(),
  answers: z.record(z.string(), z.array(z.string()))
})
export type QuestionAnswer = z.infer<typeof questionAnswer>

/**
 * The normalization layer: both execution paths (CLI adapters and the own agent
 * loop) emit exactly these events, so UI, export and search never see
 * provider-specific shapes.
 */
export const agentEvent = z.discriminatedUnion('type', [
  questionRequest,
  questionAnswer.extend({ type: z.literal('question.answered'), turnId: z.string() }),
  z.object({ type: z.literal('question.resolved'), requestId: z.string(), turnId: z.string() }),
  z.object({ type: z.literal('user.text'), turnId: z.string(), text: z.string() }),
  z.object({ type: z.literal('user.steer'), turnId: z.string(), text: z.string() }),
  z.object({ type: z.literal('turn.started'), turnId: z.string(), at: z.number() }),
  z.object({ type: z.literal('text.delta'), turnId: z.string(), text: z.string() }),
  z.object({ type: z.literal('text.done'), turnId: z.string(), text: z.string() }),
  z.object({ type: z.literal('reasoning.delta'), turnId: z.string(), text: z.string() }),
  z.object({
    type: z.literal('tool.call'),
    turnId: z.string(),
    callId: z.string(),
    // Free-form: providers invent tools (WebFetch, MCP calls) faster than any enum
    // can track, and dropping the unknown ones put silent holes in transcripts.
    name: z.string().min(1).max(128),
    args: z.unknown()
  }),
  z.object({
    type: z.literal('tool.result'),
    turnId: z.string(),
    callId: z.string(),
    ok: z.boolean(),
    output: z.string(),
    patches: z.array(filePatch).optional()
  }),
  z.object({
    type: z.literal('subagent.start'),
    turnId: z.string(),
    callId: z.string(),
    description: z.string(),
    prompt: z.string().optional()
  }),
  z.object({
    type: z.literal('subagent.meta'),
    turnId: z.string(),
    callId: z.string(),
    taskId: z.string().optional(),
    subagentType: z.string().optional(),
    backgrounded: z.boolean().optional(),
    depth: z.number().int().optional()
  }),
  z.object({
    type: z.literal('subagent.progress'),
    turnId: z.string(),
    callId: z.string(),
    tokens: z.number().optional(),
    toolUses: z.number().optional(),
    durationMs: z.number().optional(),
    lastTool: z.string().optional()
  }),
  z.object({
    type: z.literal('subagent.end'),
    turnId: z.string(),
    callId: z.string(),
    ok: z.boolean(),
    durationMs: z.number().optional(),
    report: z.string().optional()
  }),
  z.object({
    type: z.literal('usage'),
    turnId: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number().optional(),
    /** Latest request's input footprint, separate from accumulated turn usage. */
    contextTokens: z.number().optional(),
    contextWindowTokens: z.number().optional(),
    partial: z.boolean().optional(),
    scope: z.enum(['thread', 'turn', 'request']).optional(),
    cacheReadInputTokens: z.number().optional(),
    cacheWriteInputTokens: z.number().optional()
  }),
  z.object({
    type: z.literal('error'),
    turnId: z.string().optional(),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean()
  }),
  z.object({
    type: z.literal('turn.done'),
    turnId: z.string(),
    // 'interrupted': the process running the turn went away; nothing was re-sent.
    stopReason: z.enum(['end', 'cancelled', 'error', 'limit', 'interrupted']),
    // Stamped at append time so history reloads can show turn duration and date.
    at: z.number().optional()
  })
])
export type AgentEvent = z.infer<typeof agentEvent>

/** Flattens an event to human-readable text for the FTS index. */
export function renderEventForSearch(event: AgentEvent): string {
  switch (event.type) {
    case 'user.text':
    case 'user.steer':
    case 'text.done':
      return event.text
    case 'tool.call':
      return `${event.name} ${JSON.stringify(event.args)}`
    case 'tool.result':
      return event.output
    case 'subagent.start':
      return `${event.description} ${event.prompt ?? ''}`
    case 'subagent.end':
      return event.report ?? ''
    case 'error':
      return event.message
    default:
      return ''
  }
}
