import { afterEach, expect, it, vi } from 'vitest'
import type { FileNode, FilePreview, NumberedSessionEventPush } from '../../shared/ipc-contract'

const image = (data: string): FilePreview => ({
  kind: 'image',
  mimeType: 'image/png',
  dataUrl: `data:image/png;base64,${data}`
})
const node = (name: string): FileNode => ({ name, path: `shots/${name}`, kind: 'file' })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

async function fixture() {
  vi.resetModules()
  let deliver!: (event: NumberedSessionEventPush) => void
  const api = {
    files: {
      tree: vi.fn(async (): Promise<FileNode[]> => []),
      listDir: vi.fn(async (): Promise<FileNode[]> => [node('before.png')]),
      preview: vi.fn(async (): Promise<FilePreview> => image('before'))
    },
    git: {
      diff: vi.fn(async () => 'diff'),
      diffCheckpoint: vi.fn(async () => 'checkpoint'),
      status: vi.fn(async () => [])
    },
    lint: { run: vi.fn(async () => []) },
    onWorkspaceState: vi.fn(),
    onSessionEvent: (listener: typeof deliver) => {
      deliver = listener
      return vi.fn()
    }
  }
  vi.stubGlobal('window', { loom: api })
  const { useFiles, cacheKey } = await import('./files')
  const { useUi } = await import('./ui')
  useUi.setState({ route: { name: 'workspace', workspaceId: 'w1' }, workspacePane: 'chat' })
  return { api, useFiles, useUi, cacheKey, push: (event: NumberedSessionEventPush) => deliver(event) }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('activates the viewer when the same file, diff, or checkpoint is opened again', async () => {
  const { useFiles, useUi } = await fixture()
  const files = useFiles.getState()
  for (const open of [
    () => files.openAt('w1', 'shots/before.png', 12),
    () => files.openDiff('w1', 'readme.md'),
    () => files.openCheckpointDiff('w1', 'saved')
  ]) {
    await open()
    useUi.setState({ workspacePane: 'chat' })
    await open()
    expect(useUi.getState().workspacePane).toBe('viewer')
  }
})

it('retains the pane and previous file on a failed read or another workspace opening', async () => {
  const { api, useFiles, useUi } = await fixture()
  await useFiles.getState().open('w1', 'shots/before.png')
  useUi.setState({ workspacePane: 'chat' })
  api.files.preview.mockRejectedValueOnce(new Error('missing'))
  expect(await useFiles.getState().open('w1', 'missing.png')).toBe(false)
  expect(useFiles.getState().openPathByWorkspace.w1).toBe('shots/before.png')
  await useFiles.getState().open('w2', 'other.png')
  expect(useUi.getState().workspacePane).toBe('chat')
})

it('refreshes expanded directories and image bytes without changing the selected pane', async () => {
  const { api, useFiles, useUi, cacheKey } = await fixture()
  const files = useFiles.getState()
  await files.loadTree('w1')
  await files.expand('w1', 'shots')
  await files.open('w1', 'shots/before.png')
  useUi.setState({ workspacePane: 'chat' })
  api.files.listDir.mockResolvedValue([node('after.png')])
  api.files.preview.mockResolvedValue(image('after'))

  await files.refresh('w1')

  expect(useFiles.getState().childrenByPath[cacheKey('w1', 'shots')]).toEqual([node('after.png')])
  expect(useFiles.getState().contentByPath[cacheKey('w1', 'shots/before.png')]).toEqual(image('after'))
  expect(useUi.getState().workspacePane).toBe('chat')
  expect(api.lint.run).not.toHaveBeenCalled()
})

it('shares image reads without opening the viewer and forgets revoked in-flight bytes', async () => {
  const { api, useFiles, useUi, cacheKey } = await fixture()
  const bytes = deferred<FilePreview>()
  api.files.preview.mockReturnValueOnce(bytes.promise)
  const first = useFiles.getState().preview('w1', 'shot.png')
  const second = useFiles.getState().preview('w1', 'shot.png')
  expect(api.files.preview).toHaveBeenCalledTimes(1)
  useFiles.getState().forgetWorkspaces(['w1'])
  bytes.resolve(image('private'))
  await Promise.all([first, second])
  expect(useFiles.getState().contentByPath[cacheKey('w1', 'shot.png')]).toBeUndefined()
  expect(useUi.getState().workspacePane).toBe('chat')
})

it('keeps a newer directory listing when an older expansion finishes after refresh', async () => {
  const { api, useFiles, cacheKey } = await fixture()
  const old = deferred<FileNode[]>()
  api.files.listDir.mockReturnValueOnce(old.promise)
  const expanding = useFiles.getState().expand('w1', 'shots')
  api.files.listDir.mockResolvedValueOnce([node('new.png')])
  await useFiles.getState().refresh('w1')
  old.resolve([node('old.png')])
  await expanding
  expect(useFiles.getState().childrenByPath[cacheKey('w1', 'shots')]).toEqual([node('new.png')])
})

it('coalesces known writes and repeats a refresh for writes arriving during the read', async () => {
  const { api, useFiles, push } = await fixture()
  await useFiles.getState().loadTree('w1')
  const { subscribeFileUpdates } = await import('./file-updates')
  const unsubscribe = subscribeFileUpdates()
  vi.useFakeTimers()
  let seq = 0
  const write = () =>
    push({
      workspaceId: 'w1',
      sessionId: 'background',
      seq: ++seq,
      event: {
        type: 'tool.result',
        turnId: 'turn',
        callId: `call-${seq}`,
        ok: true,
        output: '',
        patches: [{ path: 'new.md', kind: 'create', diff: '' }]
      }
    })
  const first = deferred<FileNode[]>()
  api.files.tree.mockReturnValueOnce(first.promise)
  write()
  write()
  await vi.advanceTimersByTimeAsync(150)
  expect(api.files.tree).toHaveBeenCalledTimes(2)
  write()
  first.resolve([])
  await vi.advanceTimersByTimeAsync(150)
  expect(api.files.tree).toHaveBeenCalledTimes(3)
  unsubscribe()
})

it('ignores read tools and refreshes after a shell command even when it fails', async () => {
  const { api, useFiles, push } = await fixture()
  await useFiles.getState().loadTree('w1')
  const { subscribeFileUpdates } = await import('./file-updates')
  const unsubscribe = subscribeFileUpdates()
  vi.useFakeTimers()
  const call = (name: string, seq: number) => {
    push({
      workspaceId: 'w1',
      sessionId: 's',
      seq,
      event: { type: 'tool.call', turnId: 't', callId: name, name, args: {} }
    })
    push({
      workspaceId: 'w1',
      sessionId: 's',
      seq: seq + 1,
      event: { type: 'tool.result', turnId: 't', callId: name, ok: false, output: '' }
    })
  }
  call('read_file', 1)
  await vi.advanceTimersByTimeAsync(150)
  expect(api.files.tree).toHaveBeenCalledTimes(1)
  call('bash', 3)
  await vi.advanceTimersByTimeAsync(150)
  expect(api.files.tree).toHaveBeenCalledTimes(2)
  unsubscribe()
})
