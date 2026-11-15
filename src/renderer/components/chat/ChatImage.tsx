import { useEffect, useState } from 'react'
import { cacheKey, useFiles } from '../../state/files'

/** Images use the workspace reader, never a browser-relative URL or an arbitrary host file. */
function imagePath(src: string | undefined): string | undefined {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) return undefined
  try {
    const path = decodeURIComponent(src.split(/[?#]/)[0] ?? '').replace(/^\.\//, '')
    if (path === '' || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..'))
      return undefined
    return path
  } catch {
    return undefined
  }
}

export function ChatImage({
  src,
  alt,
  workspaceId,
  onOpen
}: {
  src: string | undefined
  alt: string | undefined
  workspaceId: string | undefined
  onOpen: ((path: string) => void) | undefined
}) {
  const path = imagePath(src)
  const key = workspaceId === undefined || path === undefined ? undefined : cacheKey(workspaceId, path)
  const content = useFiles((state) => (key === undefined ? undefined : state.contentByPath[key]))
  const preview = useFiles((state) => state.preview)
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const [failedSource, setFailedSource] = useState<string | null>(null)

  useEffect(() => {
    if (workspaceId === undefined || path === undefined || key === undefined) return
    let active = true
    void preview(workspaceId, path).catch(() => {
      if (active) setFailedKey(key)
    })
    return () => {
      active = false
    }
  }, [workspaceId, path, key, preview])

  const label = alt || path?.split('/').pop() || 'Image'
  const source = content?.kind === 'image' ? content.dataUrl : undefined
  if (key === undefined || failedKey === key || content?.kind === 'text' || failedSource === source) {
    return (
      <span className="chat-image-fallback" role="status">
        {label} · Cannot preview image
      </span>
    )
  }
  if (source === undefined) {
    return (
      <span className="chat-image-placeholder" role="status">
        Loading {label}…
      </span>
    )
  }
  const picture = <img src={source} alt={label} loading="lazy" onError={() => setFailedSource(source)} />
  return onOpen === undefined ? (
    <span className="chat-image">{picture}</span>
  ) : (
    <button
      type="button"
      className="chat-image"
      title={`Open ${path}`}
      aria-label={`Open image: ${label}`}
      onClick={() => {
        if (path !== undefined) onOpen(path)
      }}
    >
      {picture}
    </button>
  )
}
