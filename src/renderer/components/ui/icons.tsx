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

/** Composer tool glyphs: drawn on a 16px grid, sized by the .composer-icon rule. */
function ToolGlyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      {children}
    </svg>
  )
}

export function MicIcon() {
  return (
    <ToolGlyph>
      <path d="M8 2a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 0 1-5 0v-3A2.5 2.5 0 0 1 8 2Z" />
      <path d="M4.5 7.5a3.5 3.5 0 0 0 7 0M8 11v2.5" />
    </ToolGlyph>
  )
}

export function HeadphonesIcon() {
  return (
    <ToolGlyph>
      <path d="M2.5 10.5V8a5.5 5.5 0 0 1 11 0v2.5" />
      <rect x="2.5" y="9.5" width="2.5" height="4" rx="1" />
      <rect x="11" y="9.5" width="2.5" height="4" rx="1" />
    </ToolGlyph>
  )
}

export function SpeakerIcon() {
  return (
    <ToolGlyph>
      <path d="M3 6h2.5L9 3v10L5.5 10H3z" />
      <path d="M11.5 5.5a3.5 3.5 0 0 1 0 5" />
    </ToolGlyph>
  )
}

/** A workspace's branch with no pull request (or only closed ones). */
export function BranchIcon() {
  return (
    <ToolGlyph>
      <circle cx="11.5" cy="4" r="1.75" />
      <path d="M4.5 2v12M11.5 5.75c0 3.75-7 2.5-7 6.25" />
    </ToolGlyph>
  )
}

export function PullRequestIcon() {
  return (
    <ToolGlyph>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="12.5" r="1.5" />
      <path d="M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7M8.75 2.75 7 4.5l1.75 1.75" />
    </ToolGlyph>
  )
}

export function MergedIcon() {
  return (
    <ToolGlyph>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="9" r="1.5" />
      <path d="M4.5 5v6M4.5 5c0 2.75 2.5 4 5.5 4" />
    </ToolGlyph>
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
