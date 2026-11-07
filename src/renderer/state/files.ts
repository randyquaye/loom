import { create } from 'zustand'
import type { ChangeEntry, Diagnostic, FileNode } from '../../shared/ipc-contract'
import { useToasts } from '../components/ui/Toast'

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
  contentByPath: Record<string, { text: string; language: string }>
  diffByPath: Record<string, string>
  diagnosticsByPath: Record<string, Diagnostic[]>
  changesByWorkspace: Record<string, ChangeEntry[]>
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

  async loadTree(workspaceId) {
    const tree = await window.loom.files.tree(workspaceId)
    set({ treeByWorkspace: { ...get().treeByWorkspace, [workspaceId]: tree } })
  },

  async expand(workspaceId, path) {
    const key = cacheKey(workspaceId, path)
    if (get().childrenByPath[key] !== undefined) return
    const children = await window.loom.files.listDir(workspaceId, path)
    set({ childrenByPath: { ...get().childrenByPath, [key]: children } })
  },

  async refresh(workspaceId) {
    const openPath = get().openPathByWorkspace[workspaceId] ?? null
    const showingDiff = (get().viewerModeByWorkspace[workspaceId] ?? 'content') === 'diff'
    set({
      childrenByPath: withoutWorkspace(get().childrenByPath, workspaceId),
      diffByPath: withoutWorkspace(get().diffByPath, workspaceId)
    })
    await get().loadTree(workspaceId)
    // A diff that was on screen must not strand the viewer on Loading…: refetch it.
    if (showingDiff && openPath !== null) {
      if (openPath.startsWith('@checkpoint/')) {
        const id = openPath.slice('@checkpoint/'.length)
        try {
          const diff = await window.loom.git.diffCheckpoint(workspaceId, id)
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
    const changes = await window.loom.git.status(workspaceId)
    set({ changesByWorkspace: { ...get().changesByWorkspace, [workspaceId]: changes } })
  },

  async open(workspaceId, path) {
    const push = useToasts.getState().push
    let content: { text: string; language: string }
    try {
      content = await window.loom.files.read(workspaceId, path)
    } catch (err) {
      // Keep whatever file was showing; a failed read must not blank the viewer or spin forever.
      push(`Could not open ${path}: ${String(err)}`, 'err')
      return false
    }
    let diagnostics: Diagnostic[] = []
    try {
      diagnostics = await window.loom.lint.run(workspaceId, path, content.text)
    } catch (err) {
      // The file is still worth showing without diagnostics.
      push(`Lint failed for ${path}: ${String(err)}`, 'err')
    }
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
    if (!(await get().open(workspaceId, path))) return
    if (line !== undefined) {
      set({ revealLineByWorkspace: { ...get().revealLineByWorkspace, [workspaceId]: line } })
    }
  },

  async openDiff(workspaceId, path) {
    const push = useToasts.getState().push
    const key = cacheKey(workspaceId, path)
    if (get().diffByPath[key] === undefined) {
      try {
        const diff = await window.loom.git.diff(workspaceId, path)
        set({ diffByPath: { ...get().diffByPath, [key]: diff } })
      } catch (err) {
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
    const push = useToasts.getState().push
    const pseudo = `@checkpoint/${id}`
    const key = cacheKey(workspaceId, pseudo)
    if (get().diffByPath[key] === undefined) {
      try {
        const diff = await window.loom.git.diffCheckpoint(workspaceId, id)
        set({ diffByPath: { ...get().diffByPath, [key]: diff } })
      } catch (err) {
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
