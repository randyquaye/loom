import { randomUUID } from 'node:crypto'
import { questionRequest } from '../../../shared/events'
import { isRec, str, sub } from './record'
import type { RpcCall } from './rpc'

const decisions = [
  { label: 'Allow', description: 'Approve the requested action.', decision: 'accept' },
  { label: 'Deny', description: 'Continue without this action.', decision: 'decline' },
  { label: 'Stop turn', description: 'Deny and interrupt this turn.', decision: 'cancel' }
]

/** Uses the existing question lifecycle while keeping approval wire values inside Codex. */
export function codexApprovalQuestion(
  call: RpcCall,
  threadId: string,
  reply: (result: unknown) => Promise<void>
) {
  const file = call.method === 'item/fileChange/requestApproval'
  const permissionsRequest = call.method === 'item/permissions/requestApproval'
  if (!file && !permissionsRequest && call.method !== 'item/commandExecution/requestApproval') return
  const params = call.params
  if (call.id === undefined || !isRec(params) || str(params, 'threadId') !== threadId) return
  const turnId = str(params, 'turnId')
  const callId = str(params, 'itemId')
  if (turnId === undefined || callId === undefined) return
  const profile = permissionsRequest ? sub(params, 'permissions') : undefined
  if (permissionsRequest && profile === undefined) return
  const requested = profile === undefined ? undefined : structuredClone(profile)
  const options = permissionsRequest ? decisions.filter((option) => option.decision !== 'cancel') : decisions
  let action = 'Allow this command?'
  if (permissionsRequest) action = 'Allow these permissions for this turn?'
  else if (file) action = 'Allow these file changes?'
  else if (str(params, 'kind') === 'writeStdin') action = 'Allow input to this terminal?'
  const network = sub(params, 'networkApprovalContext') ?? {}
  const cwd = str(params, 'cwd')
  const root = str(params, 'grantRoot')
  const host = str(network, 'host')
  const question = [
    action,
    file ? undefined : str(params, 'command'),
    cwd === undefined ? undefined : `Directory: ${cwd}`,
    str(params, 'reason'),
    root === undefined ? undefined : `Requested write root for this session: ${root}`,
    host === undefined ? undefined : `Network: ${host} (${str(network, 'protocol') ?? 'network'})`,
    requested === undefined ? undefined : `Requested permissions:\n${JSON.stringify(requested, null, 2)}`
  ]
    .filter(Boolean)
    .join('\n')
  return {
    event: questionRequest.parse({
      type: 'question.requested',
      requestId: randomUUID(),
      turnId,
      callId,
      purpose: 'approval',
      blocking: true,
      questions: [
        {
          id: 'decision',
          header: 'Approval',
          question,
          options: options.map(({ label, description }) => ({ label, description }))
        }
      ]
    }),
    async reply(result: unknown): Promise<void> {
      const values = isRec(result) ? sub(sub(result, 'answers') ?? {}, 'decision')?.['answers'] : undefined
      if (!Array.isArray(values) || values.length !== 1) throw new Error('Choose one approval option')
      const decision = options.find((option) => option.label === values[0])?.decision
      if (decision === undefined) throw new Error('Unknown approval option')
      if (requested !== undefined) {
        await reply({ permissions: decision === 'accept' ? requested : {}, scope: 'turn' })
      } else {
        await reply({ decision })
      }
    }
  }
}
