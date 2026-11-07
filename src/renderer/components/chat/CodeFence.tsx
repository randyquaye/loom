import { useEffect, useState } from 'react'
import mermaid from 'mermaid'

let mermaidReady = false
let mermaidSeq = 0

/**
 * Fenced code in the transcript: a language label plus a copy action. Mermaid fences render
 * as diagrams once the reply completes; mermaid runs in its sanitizing strict mode, so no
 * script or click binding from transcript text survives into the SVG.
 */
export function CodeFence({
  lang,
  code,
  streaming = false
}: {
  lang: string | null
  code: string
  streaming?: boolean
}) {
  if (lang === 'mermaid' && !streaming) return <MermaidDiagram code={code} />
  return <CodePre lang={lang} code={code} />
}

function CodePre({ lang, code, note }: { lang: string | null; code: string; note?: string }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }

  return (
    <div className="chat-code">
      <div className="chat-code-head">
        <span className="chat-code-lang">{lang ?? 'text'}</span>
        {note === undefined ? null : <span className="chat-code-note">{note}</span>}
        <button type="button" className="chat-code-copy" onClick={copy} aria-label="Copy code">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code className={lang === null ? undefined : `language-${lang}`}>{code}</code>
      </pre>
    </div>
  )
}

function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    if (!mermaidReady) {
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
      mermaidReady = true
    }
    mermaidSeq += 1
    const id = `loom-mermaid-${mermaidSeq}`
    mermaid
      .render(id, code)
      .then((result) => {
        if (live) {
          setSvg(result.svg)
          setFailed(false)
        }
      })
      .catch(() => {
        // A failed render can leave its scratch node behind.
        for (const leftover of [id, `d${id}`]) document.getElementById(leftover)?.remove()
        if (live) {
          setSvg(null)
          setFailed(true)
        }
      })
    return () => {
      live = false
    }
  }, [code])

  if (failed) return <CodePre lang="mermaid" code={code} note="diagram parse error" />
  if (svg === null) return <div className="chat-mermaid" aria-busy="true" />
  return <div className="chat-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
}
