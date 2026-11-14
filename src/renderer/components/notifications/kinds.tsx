import type { ReactNode } from 'react'
import type { IdlePrompt, NotificationKind, NotificationOf } from '../../../shared/notifications'
import { useNotifications } from '../../state/notifications'
import { useProjects } from '../../state/projects'
import { useToasts } from '../ui/Toast'

/** What a kind shows of itself: on its card, and on its row of the Notifications page. */
interface KindView<K extends NotificationKind> {
  title(notification: NotificationOf<K>): ReactNode
  /** The line under the title; on a closed one, what became of it. */
  detail(notification: NotificationOf<K>): string
  /** The buttons that answer it, shown while it is open. */
  Actions(props: { notification: NotificationOf<K> }): ReactNode
}

function WorkspaceName({ workspaceId }: { workspaceId: string | null }) {
  const name = useProjects(
    (state) =>
      Object.values(state.workspacesByProject)
        .flat()
        .find((workspace) => workspace.id === workspaceId)?.name
  )
  return <>{name ?? 'A cloud workspace'}</>
}

const HELD_BY: Record<IdlePrompt['payload']['reason'], string> = {
  forward: 'Only a forwarded port is keeping it running.',
  command: 'Only a terminal command is keeping it running.',
  both: 'Only a forwarded port and a terminal command are keeping it running.'
}

const OUTCOME: Record<NonNullable<IdlePrompt['payload']['outcome']>, string> = {
  kept: 'Kept running',
  stopped: 'Stopped for inactivity'
}

const clockTime = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

function IdlePromptActions({ notification }: { notification: IdlePrompt }) {
  const answer = (given: 'yes' | 'no') => () =>
    void useNotifications
      .getState()
      .answer(notification.id, given)
      .catch((error: unknown) => useToasts.getState().push(String(error), 'err'))
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={answer('yes')}>
        Yes
      </button>
      <button type="button" className="btn btn-ghost" onClick={answer('no')}>
        No
      </button>
    </>
  )
}

export const KIND_VIEWS: { [K in NotificationKind]: KindView<K> } = {
  'idle-prompt': {
    title: (prompt) => <WorkspaceName workspaceId={prompt.workspaceId} />,
    detail: ({ payload }) =>
      payload.outcome === null
        ? `Are you still using this? ${HELD_BY[payload.reason]} It stops at ${clockTime(payload.stopAt)}.`
        : OUTCOME[payload.outcome],
    Actions: IdlePromptActions
  }
}
