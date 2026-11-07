import { describe, expect, it } from 'vitest'
import type { GithubRepoRef } from '../src/main/integrations/github/repo-ref'
import { parseGithubRepo } from '../src/main/integrations/github/repo-ref'

const ACCEPTED: Array<[string, GithubRepoRef]> = [
  ['https://github.com/owner/repo.git', { owner: 'owner', repo: 'repo' }],
  ['https://github.com/owner/repo', { owner: 'owner', repo: 'repo' }],
  ['https://github.com/owner/repo/', { owner: 'owner', repo: 'repo' }],
  ['http://github.com/owner/repo.git', { owner: 'owner', repo: 'repo' }],
  ['HTTPS://github.com/owner/repo.git', { owner: 'owner', repo: 'repo' }],
  ['git@github.com:owner/repo.git', { owner: 'owner', repo: 'repo' }],
  ['git@github.com:owner/repo', { owner: 'owner', repo: 'repo' }],
  ['git@GITHUB.COM:owner/repo.git', { owner: 'owner', repo: 'repo' }],
  ['github.com:owner/repo.git', { owner: 'owner', repo: 'repo' }],
  ['ssh://git@github.com/owner/repo.git', { owner: 'owner', repo: 'repo' }],
  ['ssh://git@github.com:22/owner/repo.git', { owner: 'owner', repo: 'repo' }],
  ['ssh://git@github.com:2222/owner/repo', { owner: 'owner', repo: 'repo' }],
  ['ssh://git@GITHUB.COM/owner/repo.git', { owner: 'owner', repo: 'repo' }],
  ['https://user:token@github.com/owner/repo.git', { owner: 'owner', repo: 'repo' }],
  ['https://oauth2:ghp_xYz123@github.com/owner/repo', { owner: 'owner', repo: 'repo' }],
  ['  https://github.com/owner/repo.git\n', { owner: 'owner', repo: 'repo' }],
  ['https://github.com/owner/repo/tree/main', { owner: 'owner', repo: 'repo' }],
  ['https://github.com/owner/repo/pulls', { owner: 'owner', repo: 'repo' }],
  ['https://github.com/owner/repo/blob/main/src/a.ts', { owner: 'owner', repo: 'repo' }],
  ['https://github.com/owner/repo.git/tree/main', { owner: 'owner', repo: 'repo' }],
  ['https://github.com/owner/repo?tab=readme#files', { owner: 'owner', repo: 'repo' }],
  ['https://GITHUB.COM/owner/repo.git', { owner: 'owner', repo: 'repo' }],
  ['https://GITHUB.COM/MixedCase/RepoName.git', { owner: 'MixedCase', repo: 'RepoName' }],
  ['git@github.com:MixedCase/RepoName.git', { owner: 'MixedCase', repo: 'RepoName' }],
  ['https://github.com/my-org/my-repo.git', { owner: 'my-org', repo: 'my-repo' }],
  ['https://github.com/owner/my.repo_name-v2.git', { owner: 'owner', repo: 'my.repo_name-v2' }],
  ['https://github.com/owner/repo.github.io.git', { owner: 'owner', repo: 'repo.github.io' }],
  ['https://github.com/a/b', { owner: 'a', repo: 'b' }],
  ['https://github.com/1234/5678', { owner: '1234', repo: '5678' }]
]

const REJECTED = [
  '',
  '   ',
  '\n\t ',
  'https://gitlab.com/owner/repo.git',
  'git@gitlab.com:owner/repo.git',
  'https://bitbucket.org/owner/repo',
  'https://github.example.com/owner/repo.git',
  'git@github.evil.corp:owner/repo.git',
  'https://notgithub.com/owner/repo',
  'https://github.com.evil.com/owner/repo',
  'https://evilgithub.com/owner/repo',
  'https://github.community/owner/repo',
  'https://github.com@evil.com/owner/repo',
  'https://github.com:443@evil.com/owner/repo',
  'https://github.com\\@evil.com/owner/repo',
  'https://www.github.com/owner/repo',
  'https://github.com./owner/repo',
  '/Users/me/repo',
  'relative/path/repo',
  'file:///Users/me/repo',
  'file://github.com/owner/repo',
  'git://github.com/owner/repo.git',
  'ext::sh -c payload',
  'fd::whatever',
  'github.com/owner/repo',
  '//github.com/owner/repo',
  'https://github.com',
  'https://github.com/',
  'https://github.com/owner',
  'https://github.com/owner/',
  'git@github.com:',
  'git@github.com:owner',
  'https://github.com/-owner/repo',
  'https://github.com/owner/-repo',
  'git@github.com:-owner/repo.git',
  'git@github.com:owner/-repo.git',
  'https://github.com/own_er/repo',
  'https://github.com/own.er/repo',
  'https://github.com/owner-/repo',
  'https://github.com/-owner-/repo',
  'https://github.com/owner/repo name',
  'git@github.com:owner/repo name.git',
  'https://github.com/owner/re%20po',
  'git@github.com:owner/repo?query=1',
  'git@github.com:owner/repo#fragment',
  'git@github.com:owner/.',
  'git@github.com:owner/..',
  'git@github.com:owner/.git',
  'https://github.com/owner/.git',
  'https://github.com/owner/repo.git.git',
  'git@github.com:owner/repo.git.git',
  'https://github.com/owner/repo:latest',
  'git@github.com:owner:repo',
  'https://github.com//owner/repo/..'
]

describe('parseGithubRepo', () => {
  it.each(ACCEPTED)('parses %s', (url, expected) => {
    expect(parseGithubRepo(url)).toEqual(expected)
  })

  it.each(REJECTED)('rejects %j', (url) => {
    expect(parseGithubRepo(url)).toBeNull()
  })

  it('rejects a null remote', () => {
    expect(parseGithubRepo(null)).toBeNull()
  })

  describe('length limits', () => {
    it('accepts an owner at exactly 39 characters', () => {
      const owner = 'a'.repeat(39)
      expect(parseGithubRepo(`https://github.com/${owner}/repo`)).toEqual({ owner, repo: 'repo' })
    })

    it('rejects an owner of 40 characters', () => {
      expect(parseGithubRepo(`https://github.com/${'a'.repeat(40)}/repo`)).toBeNull()
    })

    it('accepts a repo at exactly 100 characters', () => {
      const repo = 'r'.repeat(100)
      expect(parseGithubRepo(`https://github.com/owner/${repo}`)).toEqual({ owner: 'owner', repo })
    })

    it('rejects a repo of 101 characters', () => {
      expect(parseGithubRepo(`https://github.com/owner/${'r'.repeat(101)}`)).toBeNull()
    })

    it('counts the length after stripping the .git suffix', () => {
      const repo = 'r'.repeat(100)
      expect(parseGithubRepo(`https://github.com/owner/${repo}.git`)).toEqual({ owner: 'owner', repo })
      expect(parseGithubRepo(`https://github.com/owner/${repo}x.git`)).toBeNull()
    })
  })

  describe('credential stripping', () => {
    it('never leaks the user or token into owner or repo', () => {
      const ref = parseGithubRepo('https://user:p%40ss@github.com/owner/repo.git')
      expect(ref).toEqual({ owner: 'owner', repo: 'repo' })
      const flat = `${ref?.owner}${ref?.repo}`
      expect(flat).not.toContain('user')
      expect(flat).not.toContain('p%40ss')
    })
  })

  describe('case handling', () => {
    it('matches the host case-insensitively but preserves owner and repo case', () => {
      expect(parseGithubRepo('SSH://GiT@GitHuB.CoM/Owner/Repo.git')).toEqual({
        owner: 'Owner',
        repo: 'Repo'
      })
    })
  })

  it('is pure: repeated calls on the same input agree', () => {
    const url = 'git@github.com:owner/repo.git'
    expect(parseGithubRepo(url)).toEqual(parseGithubRepo(url))
  })
})
