# Loom UI design brief (parallel UI pass)

Date: 2026-11-05. Authority: orchestrator owns `theme/tokens.css`, `components/ui/**`,
`components/ModalHost.tsx`, `state/ui.ts`. Workstream agents own their scoped components
and their own scoped css file only.

## Mandates (non-negotiable)

1. **No inline appearing form fields.** Any creation/edit flow is a Modal or a Popover.
   Sidebar "add project"/"add workspace" and the composer's agent selector are modals.
1b. **No native `<select>`.** Every dropdown uses the themed `ui/Dropdown` listbox.
1c. **The file viewer lives in the middle panel as ONE pinned tab** at the left of the
   tab strip, titled with the open file name; opening another file replaces that tab's
   content (one file at a time, conductor-style). It never spawns extra tabs and never
   lives in the right pane. The right pane keeps explorer + terminal only.
1d. **One spacing grid everywhere:** 8px baseline; panel padding 16, section gap 12,
   control gap 8, list row padding 6-8. Identical across sidebar, chat, panels, home,
   settings, modals. Nothing cramped, nothing airy.
2. **Glass is for overlays and short surfaces only** (modals, popovers, palette, toasts,
   panel chrome). Forms and long text sit on solid elevated surfaces — frosted glass over
   scrolling text destroys legibility. One blur thickness per surface; edge highlight on
   every glass surface; honour `prefers-reduced-transparency` and `prefers-reduced-motion`.
3. **Command palette (Cmd/Ctrl+K)** is the primary navigation/action surface: fuzzy filter,
   grouped results, keyboard-first, footer with shortcut hints (Linear/Raycast anatomy).
4. **Dark-mode contrast discipline:** body text ≥ 7:1 on its surface, muted ≥ 4.5:1;
   never pure black backgrounds (use #07060b→#0d0a14 ramp); accent used for state and
   focus, not decoration sprawl.
5. **Motion:** 120–200 ms ease-out for overlays (fade+4px rise), 80 ms for hover states;
   streaming text gets a caret, not a spinner.

## Visual references (researched 2026-11-05)

- Cortex AI — dark glassmorphic SaaS dashboard: deep dark bg, semi-transparent panels with
  subtle borders, floating orb accents, warm accent glow.
- AI Agents Orchestration Dashboard UI (Waqar H. Syed) — agent fleet/admin panel layout.
- Orbit AI agent platform (Meduzzen, Dribbble 2026 most impactful) — "complexity must not
  leak" from the orchestration layer into the interface.
- SetProduct command-palette guide (Linear/Raycast/Vercel teardowns) — palette anatomy.
- Orizon "Glassmorphism in 2026" — the glass usage rules in mandate 2.

## Component inventory (ui/**)

Modal, Popover, CommandPalette, Toast(+viewport), Field, Button variants
(primary gradient / ghost / subtle / danger), Kbd chip, SegmentedControl, EmptyState.

## Scoped css ownership

- workstream A (claude): `sidebar.css`, `flow.css` — sidebar chrome, modals' inner forms,
  composer, session tabs.
- workstream B (codex): `chat.css` — message bubbles, tool-call cards, reasoning collapse,
  streaming caret, chat empty state.
- workstream C (qwen): `panels.css`, `home.css` — explorer/viewer/terminal chrome,
  diagnostics drawer, home history cards, settings pane.

## Visual audit pipeline

`test/e2e/shots.spec.ts` captures the key surfaces (home, workspace chat, pinned viewer
tab, an open modal, the command palette, settings) into `.qwen/tmp/loom-shots/` through
CDP, so the UI can be audited visually without OS screen-recording permission. After each
UI integration the orchestrator reads the PNGs and runs a read-only claude UI/UX audit over
the renderer plus the screenshots; findings are blocking and are fixed before the next
repackage. Spacing-grid and mandate compliance (modals not inline fields, themed
dropdowns, no click-focus chrome, 200-260ms overlay motion) is checked in that audit.

## Round 7 — transcript redesign (2026-11-05)

User verdict on the shipped chat: "this is unacceptable". Live sessions render the
agent's Markdown as raw pipe tables and `**bold**` (assistant text is plain `pre-wrap`,
never Markdown), and tool calls collapse into illegible hairlines. References for the
target look live in `.qwen/tmp/ref/`:

- `transcript-turn-collapsed.png`, `transcript-tools-expanded.png`,
  `transcript-tools-expanded2.png` — the target (conductor transcript).
- `bad-raw-markdown.png`, `bad-collapsed-tools.png` — the shipped state to eliminate.

Requirements (renderer scope: `components/chat/**`, `chat.css`; `shared/blocks.ts` may
gain an additive `turnId` on blocks plus its test updates; nothing under `main/`):

R1. Assistant text renders as GitHub-flavored Markdown (react-markdown + remark-gfm are
    already dependencies): tables with hairline borders, fenced code on solid mono
    blocks, inline code as bordered mono chips, bullets, links in accent. No bubble, no
    border, no background — flat prose at full column width. User turns keep the
    right-aligned bubble.
R2. File-reference auto-linking survives Markdown: preprocess only outside fenced and
    inline code, rewriting bare paths to a `loom:open/…` link; the `a` component for that
    protocol renders the existing link-styled opener (`onFileOpen`).
R3. Each assistant turn groups its intermediate text + tool calls behind one collapsible
    row: chevron + "N tool calls, M messages" + one small icon per tool kind present.
    The turn's final text renders flat below the group; a meta row under it shows
    `duration · date time` plus a copy-text button (navigator.clipboard).
R4. Expanded group rows are legible single lines: kind icon + label + mono arg chip
    (truncated with ellipsis): bash → "Bash" + command chip; grep → "grep for 'pattern'
    in <path>" + "<n> matches" suffix from the result; glob/read/write/edit analogous;
    failed results and error events → red circle-x row with mono chip of the first
    output/message line. Bash output, when expanded further, sits in a bordered mono
    block under its row; patches keep their diff view.
R5. Live feedback: from turn start until first content, a pulsing-dot "Thinking…" row
    with ticking elapsed seconds; tool rows appear as `tool.call` arrives with a spinner
    that resolves to ok/fail; the turn group is open while running and collapses on
    `turn.done`; the list follows the bottom while streaming unless the user has scrolled
    up (>80px), in which case follow yields until they return.
R6. Root-cause the invisible hairline tool cards of `bad-collapsed-tools.png` (the
    seeded profile's codex session carries 21 real `tool.call` events, so
    `pnpm exec playwright test test/e2e/shots.spec.ts` reproduces them) and explain the
    cause in the commit message.
R7. Tokens, 8px grid, 200-260ms overlay motion, reduced-motion fallbacks, no native
    controls — as mandated above. Definition of done: `pnpm typecheck`, `pnpm test`,
    `pnpm lint`, `pnpm build` all exit 0; shots 02/03 show rendered Markdown tables and
    legible tool rows; do not commit, do not repackage — the orchestrator does both.
