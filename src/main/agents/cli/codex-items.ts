import type { AgentEvent, FilePatch } from '../../../shared/events'
import { list, num, str, sub, type Rec } from './record'

const TOOL_NAMES = new Map([
  ['commandExecution', 'bash'],
  ['fileChange', 'edit_file'],
  ['webSearch', 'web_search']
])

function joinStrings(value: unknown): string {
  return Array.isArray(value) ? value.filter((part) => typeof part === 'string').join('\n') : ''
}

export function codexItemEvents(item: Rec, turnId: string, started: boolean): AgentEvent[] {
  const kind = str(item, 'type')
  const callId = str(item, 'id')
  if (!kind || !callId || kind === 'userMessage' || kind === 'agentMessage') return []
  if (kind === 'reasoning') {
    const text = joinStrings(item['summary']) || joinStrings(item['content'])
    return started || text === '' ? [] : [{ type: 'reasoning.delta', turnId, text }]
  }
  if (started) {
    const name =
      kind === 'mcpToolCall'
        ? `${str(item, 'server') ?? 'mcp'}/${str(item, 'tool') ?? kind}`
        : (TOOL_NAMES.get(kind) ?? kind)
    const args =
      kind === 'commandExecution'
        ? { command: item['command'], cwd: item['cwd'] }
        : (item['arguments'] ?? item)
    return [{ type: 'tool.call', turnId, callId, name: name.slice(0, 128), args }]
  }
  const payload = sub(item, 'result') ?? {}
  const error = sub(item, 'error')
  const content = list(payload, 'content')
    .map((part) => str(part, 'text') ?? '')
    .filter(Boolean)
    .join('\n')
  const structured = payload['structuredContent']
  let output = str(item, 'aggregatedOutput') ?? str(error ?? {}, 'message')
  if (output === undefined) {
    output = content
    if (output === '' && structured !== undefined) output = JSON.stringify(structured)
  }
  const status = str(item, 'status')
  const event: AgentEvent = {
    type: 'tool.result',
    turnId,
    callId,
    output,
    ok:
      (status === undefined || status === 'completed') &&
      (num(item, 'exitCode') ?? 0) === 0 &&
      error === undefined &&
      item['success'] !== false
  }
  if (kind === 'fileChange') {
    event.patches = list(item, 'changes').flatMap<FilePatch>((change) => {
      const path = str(change, 'path')
      const kind = str(sub(change, 'kind') ?? {}, 'type')
      if (path === undefined || !['add', 'update', 'delete'].includes(kind ?? '')) return []
      return [
        {
          path,
          kind: kind === 'add' ? 'create' : kind === 'delete' ? 'delete' : 'modify',
          diff: str(change, 'diff') ?? ''
        }
      ]
    })
  }
  return [event]
}
