#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

const help =
  'loom worktree create --branch NAME [--base REF]\nloom worktree register --path DIRECTORY\nloom worktree list\nReturns JSON. Creation keeps the original checkout unchanged and never pushes or fetches.'
const hardening = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.file.allow=never'
]
const git = (cwd, args) =>
  execFileSync('git', [...hardening, '-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  }).trim()

function directory(root, relative) {
  let current = root
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    try {
      mkdirSync(current)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Worktree storage must contain ordinary directories, without symlinks')
  }
  return current
}

function main(args) {
  if (args.includes('--help') || args.length === 0) return help
  const [subject, command, ...options] = args
  if (subject !== 'worktree' || !['create', 'register', 'list'].includes(command)) throw new Error(help)
  const root = realpathSync(process.env.LOOM_WORKSPACE_PATH || '')
  const workspaceId = process.env.LOOM_WORKSPACE_ID
  const sessionId = process.env.LOOM_SESSION_ID
  if (!workspaceId || !sessionId || !process.env.LOOM_WORKSPACE_PATH)
    throw new Error('Run loom inside an agent session; workspace and session identity are required')
  const flags = new Map()
  for (let i = 0; i < options.length; i += 2) {
    const name = options[i]
    const value = options[i + 1]
    if (
      !['--branch', '--base', '--path'].includes(name) ||
      !value ||
      value.startsWith('-') ||
      flags.has(name)
    )
      throw new Error(help)
    flags.set(name, value)
  }
  if (command === 'list' && options.length) throw new Error(help)
  const records = directory(root, '.context/worktrees/records')
  if (command === 'list')
    return readdirSync(records)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(path.join(records, name), 'utf8')))
  let target
  if (command === 'create') {
    if (!flags.has('--branch') || flags.has('--path')) throw new Error(help)
    const branch = flags.get('--branch')
    git(root, ['check-ref-format', `refs/heads/${branch}`])
    const base = flags.get('--base') || 'HEAD'
    if (base.startsWith('-') || /\s|:/.test(base)) throw new Error('Invalid base ref')
    const commit = git(root, ['rev-parse', '--verify', `${base}^{commit}`])
    const checkouts = directory(root, '.context/worktrees/checkouts')
    const name = createHash('sha256').update(branch).digest('hex').slice(0, 20)
    target = path.join(checkouts, name)
    git(root, ['worktree', 'add', '--no-track', '-b', branch, '--', target, commit])
  } else {
    if (!flags.has('--path') || flags.size !== 1) throw new Error(help)
    target = realpathSync(flags.get('--path'))
    const common = (cwd) => realpathSync(path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir'])))
    if (common(target) !== common(root))
      throw new Error('The worktree must belong to this workspace repository')
  }
  const branch = git(target, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const record = { workspaceId, sessionId, branch, path: realpathSync(target), recordedAt: Date.now() }
  const key = createHash('sha256').update(`${sessionId}\0${record.path}\0${branch}`).digest('hex')
  const temporary = path.join(records, `${randomUUID()}.tmp`)
  writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
  renameSync(temporary, path.join(records, `${key}.json`))
  return record
}

try {
  const result = main(process.argv.slice(2))
  process.stdout.write(typeof result === 'string' ? `${result}\n` : `${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(`${error.stderr?.toString().trim() || error.message}\n`)
  process.exitCode = 1
}
