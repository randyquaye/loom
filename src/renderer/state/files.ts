import { create } from 'zustand'
import type { ChangeEntry, Diagnostic, FileNode, FilePreview } from '../../shared/ipc-contract'
import { useToasts } from '../components/ui/Toast'
import { useProjects } from './projects'

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
  /** Re-lists the top level and drops this workspace's children and diff caches. */
  refresh(workspaceId: string): Promise<void>
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
function currentRead(workspaceId: string): () => boolean {
  const epoch = workspaceEpochs.get(workspaceId) ?? 0
  return () => (workspaceEpochs.get(workspaceId) ?? 0) === epoch
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
    const current = currentRead(workspaceId)
    const tree = await window.loom.files.tree(workspaceId)
    if (!current()) return
    set({ treeByWorkspace: { ...get().treeByWorkspace, [workspaceId]: tree } })
  },

  async expand(workspaceId, path) {
    const current = currentRead(workspaceId)
    const key = cacheKey(workspaceId, path)
    if (get().childrenByPath[key] !== undefined) return
    const children = await window.loom.files.listDir(workspaceId, path)
    if (!current()) return
    set({ childrenByPath: { ...get().childrenByPath, [key]: children } })
  },

  async refresh(workspaceId) {
    const current = currentRead(workspaceId)
    const openPath = get().openPathByWorkspace[workspaceId] ?? null
    const showingDiff = (get().viewerModeByWorkspace[workspaceId] ?? 'content') === 'diff'
    set({
      childrenByPath: withoutWorkspace(get().childrenByPath, workspaceId),
      diffByPath: withoutWorkspace(get().diffByPath, workspaceId)
    })
    await get().loadTree(workspaceId)
    if (!current()) return
    // A diff that was on screen must not strand the viewer on Loading…: refetch it.
    if (showingDiff && openPath !== null) {
      if (openPath.startsWith('@checkpoint/')) {
        const id = openPath.slice('@checkpoint/'.length)
        try {
          const diff = await window.loom.git.diffCheckpoint(workspaceId, id)
          if (!current()) return
          set({ diffByPath: { ...get().diffByPath, [cacheKey(workspaceId, openPath)]: diff } })
        } catch {
          // A pruned checkpoint simply loses its cached diff; the viewer shows Loading…
        }
      } else {
        await get().openDiff(workspaceId, openPath)
      }
    }
  },

  async loadChanges(workspaceId) {
    const current = currentRead(workspaceId)
    const changes = await window.loom.git.status(workspaceId)
    if (!current()) return
    set({ changesByWorkspace: { ...get().changesByWorkspace, [workspaceId]: changes } })
  },

  async open(workspaceId, path) {
    const current = currentRead(workspaceId)
    const push = useToasts.getState().push
    let content: FilePreview
    try {
      content = await window.loom.files.preview(workspaceId, path)
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
      contentByPath: { ...get().contentByPath, [cacheKey(workspaceId, path)]: content },
      diagnosticsByPath: { ...get().diagnosticsByPath, [cacheKey(workspaceId, path)]: diagnostics }
    })
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
    const current = currentRead(workspaceId)
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
  },

  async openCheckpointDiff(workspaceId, id) {
    const current = currentRead(workspaceId)
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
  },

  closeViewer(workspaceId) {
    set({ openPathByWorkspace: { ...get().openPathByWorkspace, [workspaceId]: null } })
  }
}))
