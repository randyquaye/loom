import { describe, expect, it } from 'vitest'
import { lintFile } from '../src/main/lint/adapters'
import { parseJsonError, parsePyCompile, parseTerraformFmt } from '../src/main/lint/parsers'
import { findOnPath } from '../src/main/lint/sandbox'

const nonInfo = (d: { severity: string }): boolean => d.severity !== 'info'

describe('lintFile', () => {
  it('maps JSON syntax errors to the right line', async () => {
    const diags = await lintFile('a.json', '{\n  "a": 1,\n  "b": }\n')
    const err = diags.find((d) => d.source === 'json')
    expect(err).toMatchObject({ severity: 'error', line: 3 })
  })

  it('reports nothing for valid, formatted JSON', async () => {
    expect(await lintFile('a.json', '{ "a": 1 }\n')).toEqual([])
  })

  it('detects TypeScript syntax errors', async () => {
    const diags = await lintFile('a.ts', 'const a = 1\nconst = 2\n')
    const err = diags.find((d) => d.source === 'typescript')
    expect(err?.severity).toBe('error')
    expect(err?.line).toBe(2)
  })

  it('detects markdownlint violations', async () => {
    const diags = await lintFile('README.md', '# Title\ntext right under heading\n')
    expect(diags.some((d) => d.source === 'markdownlint' && /MD022/.test(d.message) && d.line === 1)).toBe(
      true
    )
  })

  it('detects python syntax errors via py_compile', async () => {
    const diags = await lintFile('a.py', 'x = 1\ndef f(:\n    pass\n')
    expect(diags.filter(nonInfo)).toEqual([expect.objectContaining({ source: 'py_compile', line: 2 })])
  })

  it('runs shellcheck only when it is on PATH', async () => {
    const diags = await lintFile('a.sh', '#!/bin/sh\necho $1\n')
    const found = diags.some((d) => d.source === 'shellcheck' && d.line === 2)
    expect(found).toBe((await findOnPath('shellcheck')) !== null)
  })

  it('emits only a prettier info for unformatted code', async () => {
    const diags = await lintFile('a.js', 'const a   =  1')
    expect(diags).toEqual([expect.objectContaining({ source: 'prettier', severity: 'info' })])
  })

  it('returns nothing for unknown extensions', async () => {
    expect(await lintFile('notes.xyz', '\0 whatever {')).toEqual([])
  })
})

describe('parsers', () => {
  it('maps legacy "at position" JSON errors', () => {
    expect(parseJsonError('{\n\n x', 'Unexpected token x in JSON at position 4')).toMatchObject({
      line: 3,
      column: 2
    })
  })

  it('parses py_compile output', () => {
    const stderr = '  File "input.py", line 2\n    def f(:\n          ^\nSyntaxError: invalid syntax\n'
    expect(parsePyCompile(stderr)).toEqual([
      { source: 'py_compile', severity: 'error', message: 'SyntaxError: invalid syntax', line: 2, column: 7 }
    ])
  })

  it('parses terraform fmt diff hunks', () => {
    const diff =
      '--- old/input.tf\n+++ new/input.tf\n@@ -1,3 +1,3 @@\n resource "a" "b" {\n-x=1\n+  x = 1\n }\n'
    expect(parseTerraformFmt(diff, '')).toEqual([
      expect.objectContaining({ source: 'terraform', line: 1, endLine: 3, severity: 'warning' })
    ])
  })
})
