import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { FileNode } from '../../../shared/ipc-contract'
import { cacheKey, useFiles } from '../../state/files'
import { useProjects } from '../../state/projects'
import { ContextMenu } from '../ui/ContextMenu'
import { useToasts } from '../ui/Toast'
import { ChangesPanel } from './ChangesPanel'
import '../panels/panels.css'

function indentOf(depth: number): CSSProperties {
  return { '--depth': depth } as CSSProperties
}

interface TreeNodeProps {
  node: FileNode
  depth: number
  workspaceId: string
  expandedPaths: ReadonlySet<string>
  toggle(path: string): void
  loadDirectory(path: string): Promise<void>
}

function TreeNode({ node, depth, workspaceId, expandedPaths, toggle, loadDirectory }: TreeNodeProps) {
  const open = useFiles((s) => s.open)
  const children = useFiles((s) => s.childrenByPath[cacheKey(workspaceId, node.path)])
  const openPath = useFiles((s) => s.openPathByWorkspace[workspaceId] ?? null)
  const mode = useFiles((s) => s.viewerModeByWorkspace[workspaceId] ?? 'content')
  const expanded = expandedPaths.has(node.path)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  // A refresh drops the cache, but the expanded paths survive and reload in place.
  useEffect(() => {
    if (node.kind !== 'dir' || !expanded || children !== undefined) return
    let active = true
    setError(null)
    void loadDirectory(node.path).catch((err: unknown) => {
      if (active) setError(String(err))
    })
    return () => {
      active = false
    }
  }, [node.kind, node.path, expanded, children, loadDirectory, attempt])

  if (node.kind === 'dir') {
    return (
      <>
        <button
          type="button"
          className="tree-row tree-dir"
          style={indentOf(depth)}
          title={node.path}
          aria-expanded={expanded}
          onClick={() => toggle(node.path)}
        >
          <span className="tree-caret" data-open={expanded} aria-hidden="true">
            ▸
          </span>
          <span className="tree-name">{node.name}</span>
        </button>
        {expanded &&
          (children === undefined ? (
            error === null ? (
              <div className="tree-row tree-loading" style={indentOf(depth + 1)} role="status">
                <span className="tree-spinner" aria-hidden="true" />
                <span className="tree-name">Loading…</span>
              </div>
            ) : (
              <button
                type="button"
                className="tree-row tree-load-error"
                style={indentOf(depth + 1)}
                title={error}
                aria-label={`Retry loading ${node.path}`}
                onClick={() => setAttempt((value) => value + 1)}
              >
                Could not load. Retry
              </button>
            )
          ) : children.length === 0 ? (
            <div className="tree-row tree-subempty" style={indentOf(depth + 1)}>
              <span className="tree-name">Empty directory</span>
            </div>
          ) : (
            children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                workspaceId={workspaceId}
                expandedPaths={expandedPaths}
                toggle={toggle}
                loadDirectory={loadDirectory}
              />
            ))
          ))}
      </>
    )
  }

  const selected = openPath === node.path && mode === 'content'
  return (
    <button
      type="button"
      className={`tree-row${selected ? ' tree-on' : ''}`}
      data-file-path={node.path}
      style={indentOf(depth)}
      title={node.path}
      aria-current={selected ? 'true' : undefined}
      onClick={() => void open(workspaceId, node.path)}
    >
      <span className="tree-caret" aria-hidden="true" />
      <span className="tree-name">{node.name}</span>
    </button>
  )
}

function Explorer({ workspaceId }: { workspaceId: string }) {
  const cloud = useProjects((s) =>
    Object.values(s.workspacesByProject)
      .flat()
      .some((w) => w.id === workspaceId && w.cloud)
  )
  const push = useToasts((s) => s.push)
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null)
  const tree = useFiles((s) => s.treeByWorkspace[workspaceId])
  const expand = useFiles((s) => s.expand)
  const refresh = useFiles((s) => s.refresh)
  const loadChanges = useFiles((s) => s.loadChanges)
  const changes = useFiles((s) => s.changesByWorkspace[workspaceId])
  const [tab, setTab] = useState<'files' | 'changes'>('files')
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set())
  const [refreshingTree, setRefreshingTree] = useState(false)
  const [refreshingChanges, setRefreshingChanges] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [changesError, setChangesError] = useState<string | null>(null)
  const pendingDirectories = useRef(new Map<string, Promise<void>>())
  const changesPending = useRef(false)
  const id = useId()

  // Share in-flight reads as well as the store's completed cache, even if a
  // directory is collapsed and reopened before its first read finishes.
  const loadDirectory = useCallback(
    (path: string) => {
      const pending = pendingDirectories.current
      let request = pending.get(path)
      if (request === undefined) {
        request = expand(workspaceId, path).finally(() => pending.delete(path))
        pending.set(path, request)
      }
      return request
    },
    [expand, workspaceId]
  )

  const refreshChanges = useCallback(async () => {
    if (changesPending.current) return
    changesPending.current = true
    setRefreshingChanges(true)
    setChangesError(null)
    try {
      await loadChanges(workspaceId)
    } catch (err) {
      setChangesError(String(err))
    } finally {
      changesPending.current = false
      setRefreshingChanges(false)
    }
  }, [loadChanges, workspaceId])

  useEffect(() => {
    if (tab === 'changes' && changes === undefined) void refreshChanges()
  }, [tab, changes, refreshChanges])

  async function refreshTree() {
    setRefreshingTree(true)
    setTreeError(null)
    try {
      await refresh(workspaceId)
    } catch (err) {
      setTreeError(String(err))
    } finally {
      setRefreshingTree(false)
    }
  }

  function toggle(path: string) {
    setExpandedPaths((paths) => {
      const next = new Set(paths)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const refreshing = tab === 'files' ? refreshingTree : refreshingChanges
  return (
    <div className="tree-panel">
      <div className="explorer-bar">
        <div className="explorer-tabs" role="tablist" aria-label="Explorer">
          <button
            type="button"
            id={`${id}-files-tab`}
            role="tab"
            aria-selected={tab === 'files'}
            aria-controls={`${id}-files-panel`}
            onClick={() => setTab('files')}
          >
            Files
          </button>
          <button
            type="button"
            id={`${id}-changes-tab`}
            role="tab"
            aria-selected={tab === 'changes'}
            aria-controls={`${id}-changes-panel`}
            onClick={() => setTab('changes')}
          >
            Changes
            {changes !== undefined && <span className="explorer-count">{changes.length}</span>}
          </button>
        </div>
        <button
          type="button"
          className="icon-btn explorer-refresh"
          title={tab === 'files' ? 'Refresh tree' : 'Refresh changes'}
          aria-label={tab === 'files' ? 'Refresh tree' : 'Refresh changes'}
          aria-busy={refreshing}
          disabled={refreshing}
          onClick={() => void (tab === 'files' ? refreshTree() : refreshChanges())}
        >
          ↻
        </button>
      </div>
      <div
        className="explorer-content"
        id={`${id}-files-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-files-tab`}
        aria-busy={refreshingTree}
        hidden={tab !== 'files'}
      >
        {treeError !== null && (
          <div className="panel-empty" role="status" title={treeError}>
            Could not refresh files. Try again.
          </div>
        )}
        <div
          className="tree"
          onContextMenu={(event) => {
            if (cloud || !(event.target instanceof Element)) return
            const path = event.target.closest<HTMLElement>('[data-file-path]')?.dataset.filePath
            if (path === undefined) return
            event.preventDefault()
            setMenu({ path, x: event.clientX, y: event.clientY })
          }}
        >
          {tree?.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              workspaceId={workspaceId}
              expandedPaths={expandedPaths}
              toggle={toggle}
              loadDirectory={loadDirectory}
            />
          ))}
          {tree === undefined ? (
            <div className="panel-empty" role="status">
              Loading…
            </div>
          ) : tree.length === 0 ? (
            <div className="panel-empty">Empty worktree</div>
          ) : null}
        </div>
      </div>
      <div
        className="explorer-content"
        id={`${id}-changes-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-changes-tab`}
        aria-busy={refreshingChanges}
        hidden={tab !== 'changes'}
      >
        <ChangesPanel workspaceId={workspaceId} error={changesError} />
      </div>
      {menu !== null && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            type="button"
            role="menuitem"
            className="list-option popover-item"
            onClick={() => {
              setMenu(null)
              void window.loom.files.reveal(workspaceId, menu.path).catch((err: unknown) => {
                push(`Could not reveal ${menu.path}: ${String(err)}`, 'err')
              })
            }}
          >
            Reveal in Finder
          </button>
        </ContextMenu>
      )}
    </div>
  )
}

export function FileTree({ workspaceId }: { workspaceId: string }) {
  return <Explorer key={workspaceId} workspaceId={workspaceId} />
}
