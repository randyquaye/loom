import { create } from 'zustand'
import type { ChangeEntry, Diagnostic, FileNode, FilePreview } from '../../shared/ipc-contract'
import { useToasts } from '../components/ui/Toast'
import { useProjects } from './projects'
import { useUi } from './ui'

/** Content caches are per workspace: the same relative path differs between worktrees. */
export function cacheKey(workspaceId: string, path: string): string {
  return `${workspaceId}:${path}`
}

export type ViewerMode = 'content' | 'diff'

interface FilesState {
  /** Top level of each worktree; directories carry no children until expanded. */
  treeByWorkspace: Record<string, FileNode[]>
  childrenByPath: Record<string, FileNode[]>
  openPathByWorkspace: Record<string, string | null>
  viewerModeByWorkspace: Record<string, ViewerMode>
  revealLineByWorkspace: Record<string, number | null>
  contentByPath: Record<string, FilePreview>
  diffByPath: Record<string, string>
  diagnosticsByPath: Record<string, Diagnostic[]>
  changesByWorkspace: Record<string, ChangeEntry[]>
  /** Clear this workspace's data and invalidate outstanding reads. */
  forgetWorkspaces(workspaceIds: readonly string[]): void
  loadTree(workspaceId: string): Promise<void>
  /** Loads one directory's children once; cached until refresh. */
  expand(workspaceId: string, path: string): Promise<void>
  /** Refreshes loaded listings and previews without navigating away from chat. */
  refresh(workspaceId: string): Promise<void>
  /** Cached preview bytes for inline images; never selects the viewer or runs lint. */
  preview(workspaceId: string, path: string, reload?: boolean): Promise<FilePreview>
  loadChanges(workspaceId: string): Promise<void>
  /** Resolves false (after a toast) when the file could not be read; the previous file stays open. */
  open(workspaceId: string, path: string): Promise<boolean>
  openAt(workspaceId: string, path: string, line?: number): Promise<void>
  /** Opens the pinned viewer in diff mode for a worktree change. */
  openDiff(workspaceId: string, path: string): Promise<void>
  /** Opens the pinned viewer in diff mode for a saved checkpoint (worktree vs checkpoint). */
  openCheckpointDiff(workspaceId: string, id: string): Promise<void>
  /** Clears the open path so the pinned viewer tab disappears; the viewer mode is kept. */
  closeViewer(workspaceId: string): void
}

function withoutWorkspace<T>(records: Record<string, T>, workspaceId: string): Record<string, T> {
  return Object.fromEntries(Object.entries(records).filter(([key]) => !key.startsWith(`${workspaceId}:`)))
}

const workspaceEpochs = new Map<string, number>()
const readIds = new Map<string, symbol>()
const pendingDirectories = new Map<string, Promise<void>>()
const pendingPreviews = new Map<string, Promise<FilePreview>>()

function currentRead(workspaceId: string, resource?: string): () => boolean {
  const epoch = workspaceEpochs.get(workspaceId) ?? 0
  const key = resource === undefined ? undefined : cacheKey(workspaceId, resource)
  const id = Symbol()
  if (key !== undefined) readIds.set(key, id)
  return () =>
    (workspaceEpochs.get(workspaceId) ?? 0) === epoch && (key === undefined || readIds.get(key) === id)
}

function activateViewer(workspaceId: string): void {
  const { route } = useUi.getState()
  if (route.name === 'workspace' && route.workspaceId === workspaceId)
    useUi.setState({ workspacePane: 'viewer' })
}

function readDirectory(workspaceId: string, path: string): Promise<void> {
  const current = currentRead(workspaceId, `dir:${path}`)
  const key = cacheKey(workspaceId, path)
  const request: Promise<void> = (
    path === '' ? window.loom.files.tree(workspaceId) : window.loom.files.listDir(workspaceId, path)
  )
    .then((nodes) => {
      if (!current()) return
      useFiles.setState((state) =>
        path === ''
          ? { treeByWorkspace: { ...state.treeByWorkspace, [workspaceId]: nodes } }
          : { childrenByPath: { ...state.childrenByPath, [key]: nodes } }
      )
    })
    .finally(() => {
      if (pendingDirectories.get(key) === request) pendingDirectories.delete(key)
    })
  pendingDirectories.set(key, request)
  return request
}

export const useFiles = create<FilesState>((set, get) => ({
  treeByWorkspace: {},
  childrenByPath: {},
  openPathByWorkspace: {},
  viewerModeByWorkspace: {},
  revealLineByWorkspace: {},
  contentByPath: {},
  diffByPath: {},
  diagnosticsByPath: {},
  changesByWorkspace: {},

  forgetWorkspaces(workspaceIds) {
    for (const workspaceId of new Set(workspaceIds)) {
      workspaceEpochs.set(workspaceId, (workspaceEpochs.get(workspaceId) ?? 0) + 1)
      for (const records of [readIds, pendingDirectories, pendingPreviews]) {
        for (const key of records.keys()) if (key.startsWith(`${workspaceId}:`)) records.delete(key)
      }
      const state = get()
      const drop = <T>(values: Record<string, T>) =>
        Object.fromEntries(Object.entries(values).filter(([id]) => id !== workspaceId))
      set({
        treeByWorkspace: drop(state.treeByWorkspace),
        openPathByWorkspace: drop(state.openPathByWorkspace),
        viewerModeByWorkspace: drop(state.viewerModeByWorkspace),
        revealLineByWorkspace: drop(state.revealLineByWorkspace),
        changesByWorkspace: drop(state.changesByWorkspace),
        childrenByPath: withoutWorkspace(state.childrenByPath, workspaceId),
        contentByPath: withoutWorkspace(state.contentByPath, workspaceId),
        diffByPath: withoutWorkspace(state.diffByPath, workspaceId),
        diagnosticsByPath: withoutWorkspace(state.diagnosticsByPath, workspaceId)
      })
    }
  },

  async loadTree(workspaceId) {
    await readDirectory(workspaceId, '')
  },

  async expand(workspaceId, path) {
    const key = cacheKey(workspaceId, path)
    if (get().childrenByPath[key] !== undefined) return
    await (pendingDirectories.get(key) ?? readDirectory(workspaceId, path))
  },

  async refresh(workspaceId) {
    const state = get()
    const prefix = `${workspaceId}:`
    const paths = (keys: Iterable<string>) =>
      [...keys].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
    const directories = new Set([
      '',
      ...paths(Object.keys(state.childrenByPath)),
      ...paths(pendingDirectories.keys())
    ])
    const reads: Promise<unknown>[] = [...directories].map((path) => readDirectory(workspaceId, path))
    for (const path of paths(Object.keys(state.contentByPath))) {
      // A removed file may retain its last readable preview; other files still refresh.
      reads.push(
        get()
          .preview(workspaceId, path, true)
          .catch(() => {})
      )
    }
    if (state.changesByWorkspace[workspaceId] !== undefined) reads.push(get().loadChanges(workspaceId))
    const openPath = state.openPathByWorkspace[workspaceId] ?? null
    const showingDiff = state.viewerModeByWorkspace[workspaceId] === 'diff'
    const openKey = openPath === null ? null : cacheKey(workspaceId, openPath)
    set({
      diffByPath: Object.fromEntries(
        Object.entries(get().diffByPath).filter(
          ([key]) => !key.startsWith(prefix) || (showingDiff && key === openKey)
        )
      )
    })
    if (showingDiff && openPath !== null) {
      const current = currentRead(workspaceId, `diff:${openPath}`)
      const read = openPath.startsWith('@checkpoint/')
        ? window.loom.git.diffCheckpoint(workspaceId, openPath.slice('@checkpoint/'.length))
        : window.loom.git.diff(workspaceId, openPath)
      reads.push(
        read
          .then((diff) => {
            if (current())
              set({ diffByPath: { ...get().diffByPath, [cacheKey(workspaceId, openPath)]: diff } })
          })
          .catch(() => {})
      )
    }
    // Wait for every read, so a later write cannot overlap an unfinished refresh.
    const results = await Promise.allSettled(reads)
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  },

  async preview(workspaceId, path, reload = false) {
    const key = cacheKey(workspaceId, path)
    if (!reload) {
      const cached = get().contentByPath[key]
      if (cached !== undefined) return cached
      const pending = pendingPreviews.get(key)
      if (pending !== undefined) return pending
    }
    const current = currentRead(workspaceId, `content:${path}`)
    const request: Promise<FilePreview> = window.loom.files
      .preview(workspaceId, path)
      .then((content) => {
        if (current()) set({ contentByPath: { ...get().contentByPath, [key]: content } })
        return content
      })
      .finally(() => {
        if (pendingPreviews.get(key) === request) pendingPreviews.delete(key)
      })
    pendingPreviews.set(key, request)
    return request
  },

  async loadChanges(workspaceId) {
    const current = currentRead(workspaceId, 'changes')
    const changes = await window.loom.git.status(workspaceId)
    if (!current()) return
    set({ changesByWorkspace: { ...get().changesByWorkspace, [workspaceId]: changes } })
  },

  async open(workspaceId, path) {
    const current = currentRead(workspaceId)
    const push = useToasts.getState().push
    let content: FilePreview
    try {
      content = await get().preview(workspaceId, path, true)
    } catch (err) {
      if (!current()) return false
      // Keep whatever file was showing; a failed read must not blank the viewer or spin forever.
      push(`Could not open ${path}: ${String(err)}`, 'err')
      return false
    }
    if (!current()) return false
    let diagnostics: Diagnostic[] = []
    try {
      const workspace = Object.values(useProjects.getState().workspacesByProject)
        .flat()
        .find((row) => row.id === workspaceId)
      if (content.kind === 'text' && workspace?.bot?.access !== 'view') {
        diagnostics = await window.loom.lint.run(workspaceId, path, content.text)
      }
    } catch (err) {
      if (!current()) return false
      // The file is still worth showing without diagnostics.
      push(`Lint failed for ${path}: ${String(err)}`, 'err')
    }
    if (!current()) return false
    set({
      openPathByWorkspace: { ...get().openPathByWorkspace, [workspaceId]: path },
      viewerModeByWorkspace: { ...get().viewerModeByWorkspace, [workspaceId]: 'content' },
      revealLineByWorkspace: { ...get().revealLineByWorkspace, [workspaceId]: null },
      diagnosticsByPath: { ...get().diagnosticsByPath, [cacheKey(workspaceId, path)]: diagnostics }
    })
    activateViewer(workspaceId)
    return true
  },

  async openAt(workspaceId, path, line) {
    const current = currentRead(workspaceId)
    if (!(await get().open(workspaceId, path))) return
    if (!current()) return
    if (line !== undefined) {
      set({ revealLineByWorkspace: { ...get().revealLineByWorkspace, [workspaceId]: line } })
    }
  },

  async openDiff(workspaceId, path) {
    const current = currentRead(workspaceId, `diff:${path}`)
    const push = useToasts.getState().push
    const key = cacheKey(workspaceId, path)
    if (get().diffByPath[key] === undefined) {
      try {
        const diff = await window.loom.git.diff(workspaceId, path)
        if (!current()) return
        set({ diffByPath: { ...get().diffByPath, [key]: diff } })
      } catch (err) {
        if (!current()) return
        push(`Could not diff ${path}: ${String(err)}`, 'err')
        return
      }
    }
    set({
      openPathByWorkspace: { ...get().openPathByWorkspace, [workspaceId]: path },
      viewerModeByWorkspace: { ...get().viewerModeByWorkspace, [workspaceId]: 'diff' },
      revealLineByWorkspace: { ...get().revealLineByWorkspace, [workspaceId]: null }
    })
    activateViewer(workspaceId)
  },

  async openCheckpointDiff(workspaceId, id) {
    const current = currentRead(workspaceId, `diff:@checkpoint/${id}`)
    const push = useToasts.getState().push
    const pseudo = `@checkpoint/${id}`
    const key = cacheKey(workspaceId, pseudo)
    if (get().diffByPath[key] === undefined) {
      try {
        const diff = await window.loom.git.diffCheckpoint(workspaceId, id)
        if (!current()) return
        set({ diffByPath: { ...get().diffByPath, [key]: diff } })
      } catch (err) {
        if (!current()) return
        push(`Could not diff checkpoint: ${String(err)}`, 'err')
        return
      }
    }
    set({
      openPathByWorkspace: { ...get().openPathByWorkspace, [workspaceId]: pseudo },
      viewerModeByWorkspace: { ...get().viewerModeByWorkspace, [workspaceId]: 'diff' },
      revealLineByWorkspace: { ...get().revealLineByWorkspace, [workspaceId]: null }
    })
    activateViewer(workspaceId)
  },

  closeViewer(workspaceId) {
    set({ openPathByWorkspace: { ...get().openPathByWorkspace, [workspaceId]: null } })
  }
}))
