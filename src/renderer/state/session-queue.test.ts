import { afterEach, expect, it, vi } from 'vitest'
import type { CloudStatus, QueuedMessage, SessionQueuePush } from '../../shared/ipc-contract'
import { watchSessionQueue } from './session-queue'

afterEach(() => vi.unstubAllGlobals())

function fixture() {
  let update!: (push: SessionQueuePush) => void
  let status!: (status: CloudStatus) => void
  const answers: Array<(items: QueuedMessage[]) => void> = []
  vi.stubGlobal('window', {
    loom: {
      onSessionQueue: (listener: typeof update) => {
        update = listener
        return vi.fn()
      },
      onCloudStatus: (listener: typeof status) => {
        status = listener
        return vi.fn()
      },
      sessions: { queue: () => new Promise<QueuedMessage[]>((resolve) => answers.push(resolve)) }
    }
  })
  let shown: QueuedMessage[] = []
  const failed = vi.fn()
  const stop = watchSessionQueue(
    'session',
    (items) => {
      shown = items
    },
    failed
  )
  return {
    answers,
    stop,
    failed,
    shown: () => shown,
    push: (items: QueuedMessage[]) => update({ sessionId: 'session', items }),
    connected: () => status({ state: 'connected' })
  }
}

it('shows restored inputs after reconnect without remounting the composer', async () => {
  const f = fixture()
  f.answers[0]!([])
  await Promise.resolve()
  f.connected()
  expect(f.answers).toHaveLength(2)
  const restored = [{ id: 'accepted', text: 'waiting after restart' }]
  f.answers[1]!(restored)
  await Promise.resolve()
  expect(f.shown()).toEqual(restored)
  f.stop()
})

it('keeps a live queue update newer than a reconnect snapshot', async () => {
  const f = fixture()
  f.answers[0]!([])
  await Promise.resolve()
  f.connected()
  const newest = [{ id: 'new', text: 'new input' }]
  f.push(newest)
  f.answers[1]!([])
  await Promise.resolve()
  expect(f.shown()).toEqual(newest)
  f.stop()
})

it('ignores superseded snapshots and callbacks after the composer detaches', async () => {
  const f = fixture()
  f.connected()
  const newest = [{ id: 'new', text: 'new input' }]
  f.answers[1]!(newest)
  await Promise.resolve()
  f.answers[0]!([])
  await Promise.resolve()
  expect(f.shown()).toEqual(newest)
  f.stop()
  f.push([])
  f.connected()
  expect(f.shown()).toEqual(newest)
  expect(f.answers).toHaveLength(2)
})
