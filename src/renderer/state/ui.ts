import { create } from 'zustand'
import { useProjects } from './projects'
import { useSessions } from './sessions'

export type SettingsPage =
  'shortcuts' | 'integrations' | 'env' | 'instructions' | 'models' | 'agents' | `project:${string}`

/** Where `{ name: 'settings' }` without a page lands. */
export const DEFAULT_SETTINGS_PAGE: SettingsPage = 'shortcuts'

export type Route =
  { name: 'home' } | { name: 'workspace'; workspaceId: string } | { name: 'settings'; page?: SettingsPage }

export interface ModalFlags {
  /** Project the New Workspace modal opens on; '' opens it with no project chosen; null is closed. */
  addWorkspaceFor: string | null
  /** Open the modal's project menu (open / clone / quick start) straight away. */
  projectMenu: boolean
}

/** Mirrors main's per-send cap; the composer stops offering more once a session reaches it. */
export const MAX_ATTACHMENTS = 8

const CLOSED: ModalFlags = { addWorkspaceFor: null, projectMenu: false }

interface UiState {
  route: Route
  modals: ModalFlags
  paletteOpen: boolean
  /** One-shot prompt seeded by quick chips, consumed by whichever composer is mounted. */
  draft: string | null
  setDraft(text: string | null): void
  /**
   * Unsent composer text, keyed by session id or 'new:' + workspaceId for the start composer,
   * so tab switches, the viewer tab and route changes never discard what was typed.
   */
  draftBySession: Record<string, string>
  saveComposeDraft(key: string, text: string): void
  /**
   * Files to inline with the next send, keyed by session id: workspace-relative or absolute
   * paths. Draft state like draftBySession: per session, never persisted.
   */
  attachmentsBySession: Record<string, string[]>
  /** Ignores duplicates and anything past MAX_ATTACHMENTS. */
  addAttachment(sessionId: string, path: string): void
  removeAttachment(sessionId: string, index: number): void
  clearAttachments(sessionId: string): void
  navigate(route: Route): void
  openAddProject(): void
  /** null opens the modal prompt-first with no project chosen yet. */
  openAddWorkspace(projectId: string | null): void
  openNewSession(workspaceId: string): void
  closeModals(): void
  openPalette(): void
  closePalette(): void
  togglePalette(): void
  /** Spoken replies for foreground prose; opt-in and default off, per the blazing-fast bar. */
  voiceEnabled: boolean
  setVoiceEnabled(enabled: boolean): void
}

export const useUi = create<UiState>((set) => ({
  route: { name: 'home' },
  modals: CLOSED,
  paletteOpen: false,
  voiceEnabled: false,
  setVoiceEnabled: (voiceEnabled) => set({ voiceEnabled }),
  draft: null,
  setDraft: (draft) => set({ draft }),
  draftBySession: {},
  saveComposeDraft: (key, text) =>
    set((s) => {
      if ((s.draftBySession[key] ?? '') === text) return s
      const draftBySession = { ...s.draftBySession }
      if (text === '') delete draftBySession[key]
      else draftBySession[key] = text
      return { draftBySession }
    }),
  attachmentsBySession: {},
  addAttachment: (sessionId, path) =>
    set((s) => {
      const current = s.attachmentsBySession[sessionId] ?? []
      if (current.includes(path) || current.length >= MAX_ATTACHMENTS) return s
      return { attachmentsBySession: { ...s.attachmentsBySession, [sessionId]: [...current, path] } }
    }),
  removeAttachment: (sessionId, index) =>
    set((s) => {
      const current = s.attachmentsBySession[sessionId]
      if (current === undefined || index < 0 || index >= current.length) return s
      const next = current.filter((_, i) => i !== index)
      const attachmentsBySession = { ...s.attachmentsBySession }
      if (next.length === 0) delete attachmentsBySession[sessionId]
      else attachmentsBySession[sessionId] = next
      return { attachmentsBySession }
    }),
  clearAttachments: (sessionId) =>
    set((s) => {
      if (s.attachmentsBySession[sessionId] === undefined) return s
      const attachmentsBySession = { ...s.attachmentsBySession }
      delete attachmentsBySession[sessionId]
      return { attachmentsBySession }
    }),
  navigate: (route) => set({ route }),
  // Only one modal is ever open, so each opener replaces the whole flag set.
  // Projects are acquired inside the New Workspace modal, so "new project" opens it on its project menu.
  openAddProject: () =>
    set({
      modals: { addWorkspaceFor: useProjects.getState().projects[0]?.id ?? '', projectMenu: true },
      paletteOpen: false
    }),
  openAddWorkspace: (projectId) =>
    set({ modals: { ...CLOSED, addWorkspaceFor: projectId ?? '' }, paletteOpen: false }),
  openNewSession: (workspaceId) => {
    // Sessions start from the composer's model picker now; the empty-sentinel
    // active id puts the workspace into compose mode.
    set({ modals: CLOSED, paletteOpen: false, route: { name: 'workspace', workspaceId } })
    useSessions.getState().setActive(workspaceId, '')
  },
  closeModals: () => set({ modals: CLOSED }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen }))
}))
