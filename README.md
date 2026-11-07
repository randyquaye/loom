# Loom

A local macOS desktop app for coordinating coding agents across git worktrees, in the
spirit of conductor.build. Each project owns up to five workspaces; each workspace is a
fresh git worktree plus a gitignored `.context/` folder; each workspace hosts up to five
chat sessions (tabs); each session is pinned to one agent (backend + model + effort) for
its lifetime.

Spec: `../Documents/Work/loom-design-2026-11-04.md` (dated design doc of record).

## Providers

| Backend | Execution path                                           | Auth                                   |
| ------- | -------------------------------------------------------- | -------------------------------------- |
| codex   | CLI subprocess (`codex exec --json`)                     | ChatGPT subscription, owned by the CLI |
| claude  | CLI subprocess (`claude -p --output-format=stream-json`) | Claude subscription, owned by the CLI  |
| gemini  | own agent loop over `streamGenerateContent`              | API key in macOS Keychain              |
| qwen    | own agent loop over DashScope OpenAI-compatible SSE      | API key in macOS Keychain              |

Both paths emit one normalized `AgentEvent` stream (`src/shared/events.ts`), so the chat
UI, the Markdown exporter and full-text search never see provider-specific shapes.

## Layout

- `src/main/` — Electron main: db (SQLite + FTS5), secrets (Keychain), git/worktrees,
  agent backends (`agents/cli`, `agents/loop`), session service, PTY terminals, linters.
- `src/preload/` — the only bridge; implements `LoomApi` from `src/shared/ipc-contract.ts`.
- `src/renderer/` — React UI: sidebar, chat, explorer/viewer, terminal, home history.
- `src/shared/` — contracts: IPC channels + zod input schemas, event schema, block folding.

Every IPC input is zod-parsed in main and every call is rejected unless the sender frame
is the app's own renderer origin. Renderer-supplied paths are jailed to the workspace
worktree via `src/main/security/contain.ts`.

## Commands

```
pnpm install        # installs and rebuilds native modules for the Electron ABI
pnpm dev            # electron-vite dev server + app
pnpm build          # production build to out/
pnpm typecheck      # tsc strict over main and renderer projects
pnpm test           # vitest unit suite
pnpm test:e2e       # playwright-electron smoke (requires pnpm build first)
pnpm lint           # eslint + prettier check
pnpm package        # electron-builder macOS dmg/zip
```

Phase gates: every phase commits only after typecheck + build + unit tests + eslint +
prettier are green, plus a read-only design/security review of the phase diff.
