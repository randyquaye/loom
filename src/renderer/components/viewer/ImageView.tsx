import { useState } from 'react'

export function ImageView({ src, label }: { src: string; label: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null)
  return (
    <div className="image-view">
      {failedSource === src ? (
        <div className="viewer-empty" role="status">
          Cannot preview this image. Reveal it in Finder to open it.
        </div>
      ) : (
        <img src={src} alt={label} onError={() => setFailedSource(src)} />
      )}
    </div>
  )
}
