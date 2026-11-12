import type { WorkspaceCheckout, WorkspaceRuntimeKind } from '../../shared/ipc-contract'

export interface WorkspacePlacement {
  checkout: WorkspaceCheckout
  runtime: WorkspaceRuntimeKind
}

const PLACEMENTS = {
  worktree: { checkout: 'worktree', runtime: 'machine' },
  clone: { checkout: 'clone', runtime: 'machine' },
  container: { checkout: 'clone', runtime: 'container' }
} as const satisfies Record<string, WorkspacePlacement>

export type PlacementName = keyof typeof PLACEMENTS

/**
 * How this process places the workspaces it creates. The desktop defaults to worktrees on
 * this machine and the runner to containers. LOOM_WORKSPACE_PLACEMENT overrides either: it is
 * how a clone or container workspace is tried on a laptop, and how the runner works without Docker.
 */
export function workspacePlacement(
  fallback: PlacementName,
  override: string | undefined = process.env['LOOM_WORKSPACE_PLACEMENT']
): WorkspacePlacement {
  const name = override === undefined || override === '' ? fallback : override
  if (!Object.hasOwn(PLACEMENTS, name)) {
    throw new Error(
      `LOOM_WORKSPACE_PLACEMENT must be one of ${Object.keys(PLACEMENTS).join(', ')}; got "${name}"`
    )
  }
  return PLACEMENTS[name as PlacementName]
}
