import { describe, expect, it, vi } from 'vitest'
import { GhNotInstalledError, GhRequestError } from '../src/main/integrations/github/errors'
import { ghAuthState, ghEnv } from '../src/main/integrations/github/gh'
import {
  buildPrHeadArgs,
  buildPrListArgs,
  findPullRequestForBranch,
  listPullRequests,
  parsePrDetailList,
  parsePrList
} from '../src/main/integrations/github/prs'

const REF = { owner: 'octocat', repo: 'hello-world' }

const GH_LIST_OUTPUT = JSON.stringify([
  {
    number: 42,
    title: 'Fix the flux capacitor',
    headRefName: 'randy/fix-flux',
    baseRefName: 'main',
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/octocat/hello-world/pull/42',
    author: { login: 'randyquaye' },
    updatedAt: '2026-11-05T10:20:30Z'
  },
  {
    number: 43,
    title: 'Draft: rewrite the parser',
    headRefName: 'randy/parser',
    baseRefName: 'main',
    state: 'OPEN',
    isDraft: true,
    url: 'https://github.com/octocat/hello-world/pull/43',
    author: null,
    updatedAt: 'not-a-date'
  }
])

/** Subcommands that would write to GitHub; none may ever reach the argv. */
const MUTATING = new Set([
  'create',
  'edit',
  'comment',
  'merge',
  'close',
  'reopen',
  'delete',
  'review',
  'push',
  'checkout',
  'ready'
])

const HOSTILE_QUERIES = [
  null,
  '',
  '   ',
  'fix auth',
  '-rf',
  '--json=evil',
  '--repo=attacker/repo',
  'is:open; rm -rf /',
  'a'.repeat(500)
]

describe('buildPrListArgs', () => {
  it('targets the repo explicitly so gh never guesses from the cwd', () => {
    expect(buildPrListArgs(REF, null)).toEqual([
      'pr',
      'list',
      '--repo=octocat/hello-world',
      '--state=open',
      '--limit=50',
      '--json=number,title,headRefName,baseRefName,state,isDraft,url,author,updatedAt'
    ])
  })

  it('omits --search entirely when there is no query', () => {
    expect(buildPrListArgs(REF, null).some((a) => a.startsWith('--search'))).toBe(false)
    expect(buildPrListArgs(REF, '   ').some((a) => a.startsWith('--search'))).toBe(false)
  })

  it('glues the query to --search so a leading dash cannot become a flag', () => {
    const args = buildPrListArgs(REF, '-rf')
    expect(args).toContain('--search=-rf')
    expect(args).not.toContain('-rf')
  })

  it('cannot be steered to another repo by the query', () => {
    const args = buildPrListArgs(REF, '--repo=attacker/repo')
    expect(args).toContain('--repo=octocat/hello-world')
    expect(args).toContain('--search=--repo=attacker/repo')
    expect(args.filter((a) => a.startsWith('--repo='))).toHaveLength(1)
  })

  it('only ever emits the read-only `pr list` subcommand', () => {
    for (const query of HOSTILE_QUERIES) {
      const args = buildPrListArgs(REF, query)
      expect(args[0]).toBe('pr')
      expect(args[1]).toBe('list')
      expect(args.some((a) => MUTATING.has(a))).toBe(false)
      // Every element past the subcommand is a glued flag, so nothing can be read
      // as a positional subcommand or as a separate flag/value pair.
      expect(args.slice(2).every((a) => a.startsWith('--'))).toBe(true)
    }
  })
})

describe('parsePrList', () => {
  it('maps gh output onto the contract shape', () => {
    const prs = parsePrList(GH_LIST_OUTPUT, ['pr', 'list'])
    expect(prs).toHaveLength(2)
    expect(prs[0]).toEqual({
      number: 42,
      title: 'Fix the flux capacitor',
      headRefName: 'randy/fix-flux',
      baseRefName: 'main',
      state: 'open',
      isDraft: false,
      url: 'https://github.com/octocat/hello-world/pull/42',
      author: 'randyquaye',
      updatedAt: Date.parse('2026-11-05T10:20:30Z')
    })
  })

  it('reports a missing author as null and an unparseable timestamp as 0', () => {
    const [, second] = parsePrList(GH_LIST_OUTPUT, ['pr', 'list'])
    expect(second?.author).toBeNull()
    expect(second?.isDraft).toBe(true)
    expect(second?.updatedAt).toBe(0)
  })

  it('accepts an empty list', () => {
    expect(parsePrList('[]', ['pr', 'list'])).toEqual([])
  })

  it('rejects output that is not JSON', () => {
    expect(() => parsePrList('warning: something odd\n', ['pr', 'list'])).toThrow(GhRequestError)
    expect(() => parsePrList('nope', ['pr', 'list'])).toThrow(/GH_REQUEST_FAILED/)
  })

  it('rejects output whose shape does not match what we asked for', () => {
    expect(() => parsePrList('[{"number":1}]', ['pr', 'list'])).toThrow(GhRequestError)
    expect(() => parsePrList('[{"number":"1"}]', ['pr', 'list'])).toThrow(GhRequestError)
    const badState = GH_LIST_OUTPUT.replace('"OPEN"', '"WEIRD"')
    expect(() => parsePrList(badState, ['pr', 'list'])).toThrow(/GH_REQUEST_FAILED/)
  })

  it('rejects a top-level object rather than an array', () => {
    expect(() => parsePrList('{"number":42}', ['pr', 'list'])).toThrow(GhRequestError)
  })
})

describe('listPullRequests', () => {
  it('hands the built argv to the injected exec and parses its output', async () => {
    const seen: (readonly string[])[] = []
    const prs = await listPullRequests(REF, 'flux', async (args) => {
      seen.push(args)
      return GH_LIST_OUTPUT
    })
    expect(seen).toEqual([
      [
        'pr',
        'list',
        '--repo=octocat/hello-world',
        '--state=open',
        '--limit=50',
        expect.stringContaining('--json='),
        '--search=flux'
      ]
    ])
    expect(prs).toHaveLength(2)
  })

  it('propagates an auth failure rather than turning it into an empty list', async () => {
    await expect(
      listPullRequests(REF, null, async () => {
        throw new GhNotInstalledError()
      })
    ).rejects.toThrow(GhNotInstalledError)
  })
})

describe('ghEnv', () => {
  it('drops host and repo overrides but keeps the user credentials', () => {
    const env = ghEnv({
      PATH: '/usr/bin',
      GH_HOST: 'github.example.com',
      GITHUB_HOST: 'github.example.com',
      GH_REPO: 'attacker/repo',
      GH_TOKEN: 'kept',
      GITHUB_TOKEN: 'kept'
    })
    expect(env.GH_HOST).toBeUndefined()
    expect(env.GITHUB_HOST).toBeUndefined()
    expect(env.GH_REPO).toBeUndefined()
    expect(env.GH_TOKEN).toBe('kept')
    expect(env.GITHUB_TOKEN).toBe('kept')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('disables prompts, paging and colour so gh can never block on a question', () => {
    const env = ghEnv({})
    expect(env.GH_PROMPT_DISABLED).toBe('1')
    expect(env.GH_PAGER).toBe('cat')
    expect(env.NO_COLOR).toBe('1')
  })

  it('does not mutate the environment it was given', () => {
    const base: NodeJS.ProcessEnv = { GH_HOST: 'github.example.com', PATH: '/usr/bin' }
    ghEnv(base)
    expect(base.GH_HOST).toBe('github.example.com')
  })
})

describe('ghAuthState', () => {
  const AUTHED = [
    'github.com',
    '  ✓ Logged in to github.com account randyquaye (keyring)',
    '  - Active account: true'
  ].join('\n')

  it('reads the signed-in account out of gh status', async () => {
    expect(await ghAuthState(async () => AUTHED)).toEqual({ installed: true, account: 'randyquaye' })
  })

  it('reports a missing binary as not installed', async () => {
    expect(
      await ghAuthState(async () => {
        throw new GhNotInstalledError()
      })
    ).toEqual({ installed: false, account: null })
  })

  it('reports a non-zero exit as installed but signed out', async () => {
    expect(
      await ghAuthState(async () => {
        throw new Error('GH_NOT_AUTHENTICATED: Run `gh auth login`')
      })
    ).toEqual({ installed: true, account: null })
  })

  it('does not invent an account when only another host is signed in', async () => {
    const enterprise = '  ✓ Logged in to github.example.com account someone (keyring)'
    expect(await ghAuthState(async () => enterprise)).toEqual({ installed: true, account: null })
  })
})

/** Real gh output shape: check runs and commit statuses arrive in the same rollup. */
function detailOutput(rollup: unknown, reviewDecision: unknown = 'REVIEW_REQUIRED'): string {
  return JSON.stringify([
    {
      number: 42,
      title: 'Fix the flux capacitor',
      headRefName: 'loom/fix-flux',
      baseRefName: 'main',
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/octocat/hello-world/pull/42',
      author: { login: 'randyquaye' },
      updatedAt: '2026-11-05T10:20:30Z',
      reviewDecision,
      statusCheckRollup: rollup
    }
  ])
}

describe('buildPrHeadArgs', () => {
  it('asks for exactly the fields validated live against gh 2.96', () => {
    expect(buildPrHeadArgs(REF, 'loom/fix-flux')).toEqual([
      'pr',
      'list',
      '--repo=octocat/hello-world',
      '--state=open',
      '--limit=1',
      '--head=loom/fix-flux',
      '--json=number,title,headRefName,baseRefName,state,isDraft,url,author,updatedAt,reviewDecision,statusCheckRollup'
    ])
  })

  it('glues the head branch so a dash-leading name cannot become a flag', () => {
    const args = buildPrHeadArgs(REF, '-rf')
    expect(args).toContain('--head=-rf')
    expect(args).not.toContain('-rf')
  })

  it('stays on the read-only pr list subcommand', () => {
    for (const head of ['loom/x', '-rf', '--repo=attacker/repo', 'a/b/c']) {
      const args = buildPrHeadArgs(REF, head)
      expect(args[0]).toBe('pr')
      expect(args[1]).toBe('list')
      expect(args.some((a) => MUTATING.has(a))).toBe(false)
      expect(args.slice(2).every((a) => a.startsWith('--'))).toBe(true)
      expect(args.filter((a) => a.startsWith('--repo='))).toHaveLength(1)
    }
  })
})

describe('parsePrDetailList', () => {
  it('maps the review decision onto the contract vocabulary', () => {
    const cases: [string, string][] = [
      ['APPROVED', 'approved'],
      ['CHANGES_REQUESTED', 'changes_requested'],
      ['REVIEW_REQUIRED', 'review_required']
    ]
    for (const [raw, expected] of cases) {
      expect(parsePrDetailList(detailOutput([], raw), ['pr', 'list'])[0]?.reviewDecision).toBe(expected)
    }
  })

  it('reports an absent or unrecognised decision as none', () => {
    for (const raw of [null, '', 'SOMETHING_NEW']) {
      expect(parsePrDetailList(detailOutput([], raw), ['pr', 'list'])[0]?.reviewDecision).toBe('none')
    }
  })

  it('normalises check runs by conclusion', () => {
    const [pr] = parsePrDetailList(
      detailOutput([
        { name: 'ci/test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/1' },
        { name: 'ci/lint', status: 'IN_PROGRESS', conclusion: null, detailsUrl: 'https://ci/2' },
        { name: 'ci/e2e', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci/3' },
        { name: 'ci/deploy', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: null },
        { name: 'ci/docs', status: 'COMPLETED', conclusion: 'SKIPPED', detailsUrl: null }
      ]),
      ['pr', 'list']
    )
    expect(pr?.checks.map((c) => [c.name, c.state])).toEqual([
      ['ci/test', 'success'],
      ['ci/lint', 'pending'],
      ['ci/e2e', 'failure'],
      ['ci/deploy', 'cancelled'],
      ['ci/docs', 'skipped']
    ])
    expect(pr?.checks[0]?.detailsUrl).toBe('https://ci/1')
  })

  it('normalises commit statuses, which name themselves context/state/targetUrl', () => {
    const [pr] = parsePrDetailList(
      detailOutput([
        { context: 'ci/travis', state: 'SUCCESS', targetUrl: 'https://ci/t1' },
        { context: 'ci/coveralls', state: 'ERROR', targetUrl: 'https://ci/t2' },
        { context: 'ci/pending', state: 'PENDING', targetUrl: null }
      ]),
      ['pr', 'list']
    )
    expect(pr?.checks).toEqual([
      { name: 'ci/travis', state: 'success', detailsUrl: 'https://ci/t1' },
      { name: 'ci/coveralls', state: 'failure', detailsUrl: 'https://ci/t2' },
      { name: 'ci/pending', state: 'pending', detailsUrl: null }
    ])
  })

  it('fails safe on an unrecognised verdict rather than reporting a red check as pending', () => {
    const [pr] = parsePrDetailList(
      detailOutput([{ name: 'ci/new-thing', status: 'COMPLETED', conclusion: 'SOME_FUTURE_STATE' }]),
      ['pr', 'list']
    )
    expect(pr?.checks[0]?.state).toBe('failure')
  })

  it('treats a missing rollup as no checks and a nameless entry as "check"', () => {
    const [noRollup] = parsePrDetailList(
      JSON.stringify([{ ...JSON.parse(detailOutput([]))[0], statusCheckRollup: null }]),
      ['pr', 'list']
    )
    expect(noRollup?.checks).toEqual([])

    const [nameless] = parsePrDetailList(detailOutput([{ conclusion: 'SUCCESS' }]), ['pr', 'list'])
    expect(nameless?.checks[0]?.name).toBe('check')
  })

  it('rejects output that is not JSON or not the shape we asked for', () => {
    expect(() => parsePrDetailList('not json', ['pr', 'list'])).toThrow(/GH_REQUEST_FAILED/)
    expect(() => parsePrDetailList('[{"number":42}]', ['pr', 'list'])).toThrow(GhRequestError)
    expect(() => parsePrDetailList(detailOutput([{ name: 'x', conclusion: 3 }]), ['pr', 'list'])).toThrow(
      GhRequestError
    )
  })
})

describe('findPullRequestForBranch', () => {
  it('returns the single PR for the branch', async () => {
    const found = await findPullRequestForBranch(REF, 'loom/fix-flux', async () => detailOutput([]))
    expect(found).toMatchObject({
      number: 42,
      headRefName: 'loom/fix-flux',
      reviewDecision: 'review_required'
    })
  })

  it('returns null for an empty result, which means no PR yet', async () => {
    await expect(findPullRequestForBranch(REF, 'loom/x', async () => '[]')).resolves.toBeNull()
  })

  it('never calls gh for a detached, empty or dash-leading HEAD', async () => {
    const exec = vi.fn(async () => '[]')
    for (const head of [null, '', '-rf']) {
      await expect(findPullRequestForBranch(REF, head, exec)).resolves.toBeNull()
    }
    expect(exec).not.toHaveBeenCalled()
  })
})
