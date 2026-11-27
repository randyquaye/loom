import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { toolName, type ToolName } from '../../../shared/events'
import { globToRegex } from '../../fs/glob'
import { SKIPPED_DIRS } from '../../fs/tree'
import { contain } from '../../security/contain'
import { git } from '../../git/run'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT = 200_000
const MAX_FILES = 2000
const MAX_GREP_LINES = 200

export interface ToolCtx {
  worktreePath: string
  signal: AbortSignal
  env?: Record<string, string> | undefined
}

export interface ToolResult {
  ok: boolean
  output: string
}

export function isToolName(value: unknown): value is ToolName {
  return toolName.safeParse(value).success
}

function cap(value: string): string {
  return value.length > MAX_OUTPUT ? `…[truncated]…${value.slice(-MAX_OUTPUT)}` : value
}

const readArgs = z.object({ path: z.string() })
const writeArgs = z.object({ path: z.string(), content: z.string() })
const editArgs = z.object({ path: z.string(), oldString: z.string(), newString: z.string() })
const bashArgs = z.object({ command: z.string() })
const globArgs = z.object({ pattern: z.string() })
const grepArgs = z.object({ pattern: z.string(), dir: z.string().optional() })

async function runRead(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const parsed = readArgs.parse(args)
  const target = await contain(ctx.worktreePath, parsed.path)
  return { ok: true, output: cap(await readFile(target, 'utf8')) }
}

async function runWrite(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const parsed = writeArgs.parse(args)
  const target = await contain(ctx.worktreePath, parsed.path)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, parsed.content, 'utf8')
  return { ok: true, output: `wrote ${parsed.path}` }
}

async function runEdit(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const parsed = editArgs.parse(args)
  const target = await contain(ctx.worktreePath, parsed.path)
  const current = await readFile(target, 'utf8')
  const occurrences = current.split(parsed.oldString).length - 1
  if (occurrences !== 1) {
    return { ok: false, output: `oldString found ${occurrences} times; expected exactly 1` }
  }
  await writeFile(target, current.replace(parsed.oldString, parsed.newString), 'utf8')
  return { ok: true, output: `edited ${parsed.path}` }
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/**
 * macOS seatbelt profile: writes confined to the worktree and tmp, reads denied
 * outside system paths + worktree + tmp, so a compromised model stream cannot
 * read ~/.ssh or ~/.aws even though bash runs with the user's privileges.
 */
function sandboxProfile(worktree: string, commonGitDir?: string): string {
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal)
(allow sysctl-read)
(allow network*)
(allow file-read* (subpath "/usr") (subpath "/private/usr") (subpath "/System") (subpath "/Library") (subpath "/dev") (subpath "/opt") (subpath "${worktree}") (subpath "/tmp") (subpath "/private/tmp"))
(allow file-write* (subpath "${worktree}") (subpath "/tmp") (subpath "/private/tmp"))
${commonGitDir === undefined ? '' : `(allow file-read* file-write* (subpath ${JSON.stringify(commonGitDir)}))`}
`
}

async function runBash(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const parsed = bashArgs.parse(args)
  const worktree = await realpath(ctx.worktreePath).catch(() => ctx.worktreePath)
  let argv: string[] = ['/bin/bash', '-c', parsed.command]
  let profileDir: string | null = null
  if (existsSync(SANDBOX_EXEC)) {
    // Linked worktrees keep the Git metadata needed to create a checkout outside their root.
    const common = ctx.env?.LOOM_SESSION_ID
      ? await git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(
          () => undefined
        )
      : undefined
    profileDir = await mkdtemp(path.join(tmpdir(), 'loom-sbx-'))
    const profilePath = path.join(profileDir, 'profile.sb')
    await writeFile(profilePath, sandboxProfile(worktree, common), 'utf8')
    argv = [SANDBOX_EXEC, '-f', profilePath, '/bin/bash', '-c', parsed.command]
  }
  try {
    const { stdout, stderr } = await execFileAsync(argv[0] as string, argv.slice(1), {
      cwd: ctx.worktreePath,
      signal: ctx.signal,
      maxBuffer: MAX_OUTPUT * 2,
      env: {
        PATH: ctx.env?.PATH ?? process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
        ...Object.fromEntries(
          Object.entries(ctx.env ?? {}).filter(([key]) =>
            ['LOOM_WORKSPACE_PATH', 'LOOM_WORKSPACE_ID', 'LOOM_SESSION_ID'].includes(key)
          )
        )
      }
    })
    return { ok: true, output: cap(stdout + stderr) }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, output: cap(`${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`) }
  } finally {
    if (profileDir !== null) await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) return
    if (SKIPPED_DIRS.has(entry.name)) continue
    // Symlinks are never descended or listed: a planted link must not let glob
    // or grep enumerate or read paths outside the worktree.
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, root, out)
    else out.push(path.relative(root, full))
  }
}

async function runGlob(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const parsed = globArgs.parse(args)
  const re = globToRegex(parsed.pattern)
  const files: string[] = []
  await walk(ctx.worktreePath, ctx.worktreePath, files)
  return { ok: true, output: cap(files.filter((f) => re.test(f)).join('\n') || '(no matches)') }
}

async function runGrep(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const parsed = grepArgs.parse(args)
  const base = await contain(ctx.worktreePath, parsed.dir ?? '.')
  // System grep runs in a child (a pathological pattern cannot freeze the app)
  // and -r does not follow symlinks, so a planted link cannot leak outside.
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/grep',
      [
        '-rn',
        '--binary-files=without-match',
        '-m',
        String(MAX_GREP_LINES),
        '-E',
        '-e',
        parsed.pattern,
        '--',
        base
      ],
      { cwd: ctx.worktreePath, signal: ctx.signal, maxBuffer: MAX_OUTPUT }
    )
    return { ok: true, output: cap(stdout || '(no matches)') }
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string }
    if (err.code === 1) return { ok: true, output: '(no matches)' }
    return { ok: false, output: cap(String(err.stdout ?? error)) }
  }
}

export const toolRunners: Record<ToolName, (args: unknown, ctx: ToolCtx) => Promise<ToolResult>> = {
  read_file: runRead,
  write_file: runWrite,
  edit_file: runEdit,
  bash: runBash,
  glob: runGlob,
  grep: runGrep
}

/**
 * Advertised parameter schemas derived from the zod arg schemas, so runtime
 * validation and the model-facing declarations cannot drift apart.
 */
function schemaToProps(schema: z.ZodObject<z.ZodRawShape>): {
  properties: Record<string, { type: string }>
  required: string[]
} {
  const properties: Record<string, { type: string }> = {}
  const required: string[] = []
  for (const [key, field] of Object.entries(schema.shape)) {
    properties[key] = { type: 'string' }
    if (!(field as z.ZodTypeAny).safeParse(undefined).success) required.push(key)
  }
  return { properties, required }
}

export const TOOL_PARAMETER_SCHEMAS: Record<
  ToolName,
  { properties: Record<string, { type: string }>; required: string[] }
> = {
  read_file: schemaToProps(readArgs),
  write_file: schemaToProps(writeArgs),
  edit_file: schemaToProps(editArgs),
  bash: schemaToProps(bashArgs),
  glob: schemaToProps(globArgs),
  grep: schemaToProps(grepArgs)
}
