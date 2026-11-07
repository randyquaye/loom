import type { Diagnostic } from '../../shared/ipc-contract'

export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length))
  const before = text.slice(0, clamped)
  const lastNewline = before.lastIndexOf('\n')
  return { line: before.split('\n').length, column: clamped - lastNewline }
}

/**
 * V8 reports "(line L column C)", only "at position N", or (for some
 * unexpected-token errors) no location at all; fallbackOffset covers the last.
 */
export function parseJsonError(
  text: string,
  message: string,
  fallbackOffset: number = text.length
): Diagnostic {
  const base = { source: 'json', severity: 'error' as const, message }
  const lineCol = /\(line (\d+) column (\d+)\)/.exec(message)
  if (lineCol !== null) return { ...base, line: Number(lineCol[1]), column: Number(lineCol[2]) }
  const position = /at position (\d+)/.exec(message)
  const offset = position !== null ? Number(position[1]) : fallbackOffset
  return { ...base, ...lineColumnAt(text, offset) }
}

/** py_compile prints a traceback-like block: `File "x.py", line N`, source, caret, then `XxxError: msg`. */
export function parsePyCompile(stderr: string): Diagnostic[] {
  const lines = stderr.split('\n')
  const lineIdx = lines.findIndex((l) => /File ".*", line \d+/.test(l))
  if (lineIdx === -1) return []
  const lineNo = Number(/line (\d+)/.exec(lines[lineIdx] ?? '')?.[1] ?? '1')
  const caretLine = lines.slice(lineIdx + 1).find((l) => /^\s*\^+\s*$/.test(l))
  const sourceLine = lines[lineIdx + 1] ?? ''
  const column =
    caretLine === undefined ? 1 : Math.max(1, caretLine.indexOf('^') - leadingSpaces(sourceLine) + 1)
  const message = [...lines].reverse().find((l) => /^\w*(Error|Exception)\b/.test(l.trim())) ?? 'syntax error'
  return [{ source: 'py_compile', severity: 'error', message: message.trim(), line: lineNo, column }]
}

function leadingSpaces(s: string): number {
  return s.length - s.trimStart().length
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/

export function parseTerraformFmt(stdout: string, stderr: string): Diagnostic[] {
  const syntax = [...stderr.matchAll(/^Error: (.+)$[\s\S]*?on \S+ line (\d+)/gm)].map((m): Diagnostic => ({
    source: 'terraform',
    severity: 'error',
    message: m[1] ?? 'syntax error',
    line: Number(m[2]),
    column: 1
  }))
  const hunks = stdout
    .split('\n')
    .map((l) => HUNK_HEADER.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m): Diagnostic => {
      const start = Number(m[1])
      const count = m[2] === undefined ? 1 : Number(m[2])
      return {
        source: 'terraform',
        severity: 'warning',
        message: 'terraform fmt would reformat this block',
        line: Math.max(1, start),
        column: 1,
        endLine: Math.max(1, start + count - 1)
      }
    })
  return [...syntax, ...hunks]
}

interface ShellcheckItem {
  line: number
  endLine: number
  column: number
  endColumn: number
  level: string
  code: number
  message: string
}

function isShellcheckItem(v: unknown): v is ShellcheckItem {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o['line'] === 'number' &&
    typeof o['column'] === 'number' &&
    typeof o['endLine'] === 'number' &&
    typeof o['endColumn'] === 'number' &&
    typeof o['level'] === 'string' &&
    typeof o['code'] === 'number' &&
    typeof o['message'] === 'string'
  )
}

function shellcheckSeverity(level: string): Diagnostic['severity'] {
  if (level === 'error') return 'error'
  if (level === 'warning') return 'warning'
  return 'info'
}

export function parseShellcheckJson(stdout: string): Diagnostic[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isShellcheckItem).map((item) => ({
    source: 'shellcheck',
    severity: shellcheckSeverity(item.level),
    message: `SC${item.code}: ${item.message}`,
    line: item.line,
    column: item.column,
    endLine: item.endLine,
    endColumn: item.endColumn
  }))
}
