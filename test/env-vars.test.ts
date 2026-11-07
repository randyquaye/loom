import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import {
  assertEnvName,
  deleteEnvVar,
  envNames,
  EnvNameRejectedError,
  envOverlay,
  listEnvVars,
  setEnvSecretStore,
  setEnvVar
} from '../src/main/env/vars'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'
import { workspaceEnv } from '../src/main/workspace/bootstrap'

beforeEach(() => {
  setEnvSecretStore(
    createSecretStore(
      path.join(mkdtempSync(path.join(tmpdir(), 'loom-env-')), 'secrets.enc'),
      aesGcmCipher(randomBytes(32))
    )
  )
})

describe('assertEnvName', () => {
  it('accepts shell identifiers', () => {
    for (const ok of ['API_KEY', '_x', 'MY_VAR_2']) expect(() => assertEnvName(ok)).not.toThrow()
  })

  it('rejects malformed names, the LOOM_ prefix and process-reserved names', () => {
    for (const bad of [
      '',
      '9LIVES',
      'MY-VAR',
      'MY VAR',
      'LOOM_PORT',
      'PATH',
      'HOME',
      'SHELL',
      'x'.repeat(129)
    ]) {
      expect(() => assertEnvName(bad), bad).toThrow(EnvNameRejectedError)
    }
  })
})

describe('env var storage', () => {
  it('lists names masked and never the value', async () => {
    await setEnvVar('global', null, 'DEPLOY_TOKEN', 'super-secret-value-1234')

    const rows = await listEnvVars('global')

    expect(rows).toEqual([{ name: 'DEPLOY_TOKEN', masked: '••••1234' }])
    expect(JSON.stringify(rows)).not.toContain('super-secret-value-1234')
  })

  it('keeps scopes separate and lets a project override global', async () => {
    await setEnvVar('global', null, 'REGION', 'eu-west-1')
    await setEnvVar('global', null, 'SHARED', 'g')
    await setEnvVar('project', 'p1', 'REGION', 'us-east-2')

    expect(await envOverlay('p1')).toEqual({ REGION: 'us-east-2', SHARED: 'g' })
    expect(await envOverlay('p2')).toEqual({ REGION: 'eu-west-1', SHARED: 'g' })
    expect(await envNames('p1')).toEqual(['REGION', 'SHARED'])
  })

  it('deletes within one scope only', async () => {
    await setEnvVar('project', 'p1', 'ONLY', 'v')
    await setEnvVar('global', null, 'ONLY', 'v')

    await deleteEnvVar('project', 'p1', 'ONLY')

    expect(await listEnvVars('project', 'p1')).toEqual([])
    expect(await listEnvVars('global')).toHaveLength(1)
  })

  it('refuses project scope without a project id', async () => {
    await expect(listEnvVars('project', null)).rejects.toThrow(EnvNameRejectedError)
  })
})

describe('workspaceEnv injection', () => {
  function seededDb() {
    const db = openDb(':memory:')
    db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
      'p1',
      'demo',
      '/tmp/demo',
      1
    )
    db.prepare(
      'INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('w1', 'p1', 'ws', 'loom/ws', '/tmp/wt', 1)
    return db
  }

  it('merges global and project vars into the workspace environment alongside LOOM_*', async () => {
    const db = seededDb()
    await setEnvVar('global', null, 'GLOBAL_VAR', 'gv')
    await setEnvVar('project', 'p1', 'PROJECT_VAR', 'pv')

    const env = await workspaceEnv(db, 'w1')

    expect(env.GLOBAL_VAR).toBe('gv')
    expect(env.PROJECT_VAR).toBe('pv')
    expect(env.LOOM_WORKSPACE_NAME).toBe('ws')
  })

  it('cannot be used to shadow a LOOM_ variable', async () => {
    const db = seededDb()
    await expect(setEnvVar('global', null, 'LOOM_WORKSPACE_NAME', 'evil')).rejects.toThrow(
      EnvNameRejectedError
    )
    expect((await workspaceEnv(db, 'w1')).LOOM_WORKSPACE_NAME).toBe('ws')
  })
})
