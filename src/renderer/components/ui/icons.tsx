import type { ReactNode } from 'react'

const FOLDER = 'M3 5.5h5l2 2h7v9H3z'

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function FolderIcon() {
  return (
    <Glyph>
      <path d={FOLDER} />
    </Glyph>
  )
}

export function FolderPlusIcon() {
  return (
    <Glyph>
      <path d={FOLDER} />
      <path d="M10 9v4.5M7.75 11.25h4.5" />
    </Glyph>
  )
}

export function GlobeIcon() {
  return (
    <Glyph>
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14M10 3c1.9 2 2.8 4.4 2.8 7s-.9 5-2.8 7c-1.9-2-2.8-4.4-2.8-7S8.1 5 10 3z" />
    </Glyph>
  )
}
