import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { refreshWorkspaceAgentsDoc } from '../src/main/context/materialize'
import { setAgentsExclude } from '../src/main/git/exclude'
import { GIT_HARDENING_ARGS } from '../src/main/git/run'

const execFileAsync = promisify(execFile)

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'loom-agentsdoc-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  await mkdir(repo, { recursive: true })
  await execFileAsync('git', [...GIT_HARDENING_ARGS, 'init', '-q', '-b', 'main', repo], { shell: false })
  return repo
}

const MANAGED = '<!-- loom:managed -->'

describe('managed AGENTS.md companion', () => {
  it('writes a marker-first companion and excludes it while owned', async () => {
    const repo = await gitRepo()

    expect(await refreshWorkspaceAgentsDoc(repo, 'facts here')).toBe(true)
    const body = await readFile(path.join(repo, 'AGENTS.md'), 'utf8')
    expect(body.startsWith(MANAGED)).toBe(true)
    expect(body).toContain('facts here')

    await setAgentsExclude(repo, true)
    const exclude = await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n')).toContain('/AGENTS.md')
  })

  it('never overwrites a repo or user AGENTS.md and withdraws the exclude line', async () => {
    const repo = await gitRepo()
    await writeFile(path.join(repo, 'AGENTS.md'), '# mine\n', 'utf8')
    await setAgentsExclude(repo, true)

    expect(await refreshWorkspaceAgentsDoc(repo, 'facts here')).toBe(false)
    await setAgentsExclude(repo, false)
    const exclude = await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n')).not.toContain('/AGENTS.md')
    expect(await readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe('# mine\n')
  })

  it('refreshes a managed companion in place', async () => {
    const repo = await gitRepo()
    await refreshWorkspaceAgentsDoc(repo, 'v1')
    await refreshWorkspaceAgentsDoc(repo, 'v2')

    const body = await readFile(path.join(repo, 'AGENTS.md'), 'utf8')
    expect(body).toContain('v2')
    expect(body).not.toContain('v1')
  })
})
