import { Editor, loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import { useCallback, useEffect, useRef } from 'react'
import type { Diagnostic } from '../../../shared/ipc-contract'

const env = globalThis as typeof globalThis & { MonacoEnvironment?: monaco.Environment }
env.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}
loader.config({ monaco })

const LANGUAGE_BY_EXT: Record<string, string> = {
  md: 'markdown',
  json: 'json',
  js: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  sh: 'shell',
  py: 'python',
  // monaco ships no HCL tokenizer; diagnostics still surface via the panel below
  tf: 'plaintext'
}

export function languageFor(path: string): string {
  const ext = path.split('.').pop() ?? ''
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext'
}

export function MonacoView({
  path,
  text,
  diagnostics,
  revealLine
}: {
  path: string
  text: string
  diagnostics: Diagnostic[]
  revealLine: number | null
}) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const diagnosticsRef = useRef(diagnostics)
  diagnosticsRef.current = diagnostics

  const apply = useCallback(() => {
    const editor = editorRef.current
    const model = editor?.getModel() ?? null
    if (editor === null || model === null) return
    monaco.editor.setModelMarkers(
      model,
      'loom',
      diagnosticsRef.current.map((d) => ({
        severity:
          d.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : d.severity === 'warning'
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
        message: `[${d.source}] ${d.message}`,
        startLineNumber: d.line,
        startColumn: d.column,
        endLineNumber: d.endLine ?? d.line,
        endColumn: d.endColumn ?? d.column + 1
      }))
    )
  }, [])

  useEffect(() => {
    apply()
  }, [diagnostics, apply])

  useEffect(() => {
    if (revealLine !== null && editorRef.current) {
      editorRef.current.revealLineInCenter(revealLine)
      editorRef.current.setPosition({ lineNumber: revealLine, column: 1 })
    }
  }, [revealLine, path])

  return (
    <Editor
      path={path}
      language={languageFor(path)}
      value={text}
      theme="vs-dark"
      onMount={(editor) => {
        editorRef.current = editor
        apply()
      }}
      options={{
        readOnly: true,
        minimap: { enabled: false },
        fontSize: 12,
        scrollBeyondLastLine: false,
        automaticLayout: true
      }}
    />
  )
}
