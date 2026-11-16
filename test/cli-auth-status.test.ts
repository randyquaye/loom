import { describe, expect, it, vi } from 'vitest'
import { cliAuthStatus } from '../src/main/agents/cli/probe'

describe.each(['codex', 'claude'] as const)('%s sign-in status', (bin) => {
  it('reports connected only after the CLI reports successful authentication', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    await expect(cliAuthStatus(bin, 'Install the CLI', run)).resolves.toEqual({ state: 'ready' })
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual([
      bin,
      bin === 'codex' ? ['login', 'status'] : ['auth', 'status']
    ])
  })

  it('distinguishes a missing executable from an installed, signed-out CLI', async () => {
    const run = vi.fn().mockRejectedValue({ code: 'ENOENT' })
    await expect(cliAuthStatus(bin, 'Install the CLI', run)).resolves.toEqual({
      state: 'not-installed',
      hint: 'Install the CLI'
    })
    run.mockRejectedValue({
      code: 1,
      stdout: bin === 'claude' ? '{"loggedIn":false}' : '',
      stderr: bin === 'codex' ? 'Not logged in\n' : ''
    })
    await expect(cliAuthStatus(bin, 'Install the CLI', run)).resolves.toMatchObject({
      state: 'needs-login',
      hint: expect.stringContaining(bin === 'codex' ? 'codex login' : 'claude auth login')
    })
  })

  it.each([
    { code: 1, stdout: 'invalid response', stderr: 'private-detail' },
    { code: 1, stdout: '{"loggedIn":false}', stderr: 'Not logged in', killed: true },
    { code: 2, stderr: 'private-detail' },
    { code: 'EACCES', stderr: 'private-detail' },
    { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr: 'private-detail' }
  ])('keeps failed checks distinct from signed-out accounts: %j', async (failure) => {
    const run = vi.fn().mockRejectedValue(failure)
    const status = await cliAuthStatus(bin, 'Install the CLI', run)
    expect(status).toMatchObject({ state: 'error' })
    expect(JSON.stringify(status)).not.toContain('private-detail')
  })
})
