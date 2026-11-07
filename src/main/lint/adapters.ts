import path from 'node:path'
import * as prettier from 'prettier'
import ts from 'typescript'
import type { Diagnostic } from '../../shared/ipc-contract'
import { parseJsonError, parsePyCompile, parseShellcheckJson, parseTerraformFmt } from './parsers'
import { findOnPath, runTool, withTempCopy } from './sandbox'
import { lint as markdownLint } from 'markdownlint/promise'

type Linter = (text: string) => Promise<Diagnostic[]>

/** Rules that fight prose style rather than correctness; keep the signal high. */
const MD_CONFIG = { default: true, MD013: false, MD041: false, MD033: false }

/** TypeScript's JSON parser only locates the error; JSON.parse stays the authority on validity. */
function jsonErrorOffset(text: string): number | undefined {
  const sf = ts.parseJsonText('input.json', text)
  return parseDiagnosticsOf(sf)[0]?.start
}

export function lintJson(text: string): Promise<Diagnostic[]> {
  try {
    JSON.parse(text)
    return Promise.resolve([])
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Promise.resolve([parseJsonError(text, message, jsonErrorOffset(text))])
  }
}

function scriptKindFor(ext: string): ts.ScriptKind {
  if (ext === '.tsx') return ts.ScriptKind.TSX
  if (ext === '.js') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

// parseDiagnostics is populated by the parser but marked @internal in typescript.d.ts.
function parseDiagnosticsOf(sf: ts.SourceFile): readonly ts.DiagnosticWithLocation[] {
  const internal = sf as unknown as { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }
  return internal.parseDiagnostics ?? []
}

export function lintTypeScript(text: string, ext: string): Promise<Diagnostic[]> {
  const sf = ts.createSourceFile(`input${ext}`, text, ts.ScriptTarget.Latest, false, scriptKindFor(ext))
  const diagnostics = parseDiagnosticsOf(sf).map((d): Diagnostic => {
    const start = sf.getLineAndCharacterOfPosition(d.start)
    const end = sf.getLineAndCharacterOfPosition(d.start + d.length)
    return {
      source: 'typescript',
      severity: 'error',
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      line: start.line + 1,
      column: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1
    }
  })
  return Promise.resolve(diagnostics)
}

/** In-process so markdown diagnostics work identically in packaged builds. */
export async function lintMarkdown(text: string): Promise<Diagnostic[]> {
  const results = await markdownLint({ strings: { input: text }, config: MD_CONFIG })
  return (results.input ?? []).map((e) => ({
    source: 'markdownlint',
    severity: 'error' as const,
    message: `${e.ruleNames.join('/')} ${e.ruleDescription}${e.errorDetail ? `: ${e.errorDetail}` : ''}`,
    line: e.lineNumber,
    column: 1
  }))
}

export function lintPython(text: string): Promise<Diagnostic[]> {
  return withTempCopy('input.py', text, async (dir, file) => {
    const { code, stderr } = await runTool('python3', ['-I', '-m', 'py_compile', file], dir)
    return code === 0 ? [] : parsePyCompile(stderr)
  })
}

export async function lintTerraform(text: string): Promise<Diagnostic[]> {
  const bin = await findOnPath('terraform')
  if (bin === null) return []
  return withTempCopy('input.tf', text, async (dir, file) => {
    const { stdout, stderr } = await runTool(bin, ['fmt', '-check', '-diff', '-no-color', file], dir)
    return parseTerraformFmt(stdout, stderr)
  })
}

export async function lintShell(text: string): Promise<Diagnostic[]> {
  const bin = await findOnPath('shellcheck')
  if (bin === null) return []
  return withTempCopy('input.sh', text, async (dir, file) => {
    const { stdout } = await runTool(bin, ['--norc', '-f', 'json', file], dir)
    return parseShellcheckJson(stdout)
  })
}

const PRETTIER_PARSER_BY_EXT: Readonly<Record<string, string>> = {
  '.md': 'markdown',
  '.json': 'json',
  '.js': 'babel',
  '.ts': 'typescript',
  '.tsx': 'typescript'
}

/**
 * Uses prettier defaults: resolving the worktree's prettier config could load
 * a JS config file, i.e. execute repo code.
 */
export async function prettierCheck(text: string, ext: string): Promise<Diagnostic[]> {
  const parser = PRETTIER_PARSER_BY_EXT[ext]
  if (parser === undefined) return []
  try {
    if (await prettier.check(text, { parser })) return []
  } catch {
    return []
  }
  const message = 'File is not prettier-formatted'
  return [{ source: 'prettier', severity: 'info', message, line: 1, column: 1 }]
}

function linterFor(ext: string): Linter | null {
  switch (ext) {
    case '.json':
      return lintJson
    case '.md':
      return lintMarkdown
    case '.ts':
    case '.tsx':
    case '.js':
      return (text) => lintTypeScript(text, ext)
    case '.py':
      return lintPython
    case '.tf':
      return lintTerraform
    case '.sh':
      return lintShell
    default:
      return null
  }
}

async function settle(run: Promise<Diagnostic[]>, source: string): Promise<Diagnostic[]> {
  try {
    return await run
  } catch (e) {
    const message = `linter unavailable: ${e instanceof Error ? e.message : String(e)}`
    return [{ source, severity: 'info', message, line: 1, column: 1 }]
  }
}

export async function lintFile(relPath: string, text: string): Promise<Diagnostic[]> {
  const ext = path.extname(relPath).toLowerCase()
  const linter = linterFor(ext)
  const [primary, format] = await Promise.all([
    linter === null ? Promise.resolve([]) : settle(linter(text), ext.slice(1)),
    prettierCheck(text, ext)
  ])
  return [...primary, ...format]
}
