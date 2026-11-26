import { create } from 'zustand'
import { MAX_ATTACHMENTS } from '../../shared/limits'
import { useProjects } from './projects'
import { useSessions } from './sessions'

export type SettingsPage =
  | 'preferences'
  | 'shortcuts'
  | 'updates'
  | 'integrations'
  | 'cloud'
  | 'org-overview'
  | 'org-members'
  | 'org-log'
  | 'org-bots'
  | 'org-subscriptions'
  | 'env'
  | 'instructions'
  | 'models'
  | 'agents'
  | `project:${string}`

/** Where `{ name: 'settings' }` without a page lands. */
export const DEFAULT_SETTINGS_PAGE: SettingsPage = 'preferences'

export type Route =
  | { name: 'home' }
  | { name: 'workspace'; workspaceId: string }
  | { name: 'notifications' }
  | { name: 'settings'; page?: SettingsPage }

export interface ModalFlags {
  /** Project the New Workspace modal opens on; '' opens it with no project chosen; null is closed. */
  addWorkspaceFor: string | null
  /** Open the modal's project menu (open / clone / quick start) straight away. */
  projectMenu: boolean
}

export { MAX_ATTACHMENTS }

export interface QuestionDraft {
  selected: Record<string, string[]>
  text: Record<string, string>
}

const CLOSED: ModalFlags = { addWorkspaceFor: null, projectMenu: false }

interface UiState {
  route: Route
  /** Captured on entry to Settings; switching Settings pages keeps the original destination. */
  settingsReturnRoute: Exclude<Route, { name: 'settings' }>
  settingsLocation: 'mac' | 'cloud'
  setSettingsLocation(location: 'mac' | 'cloud'): void
  workspacePane: 'chat' | 'viewer' | 'terminal'
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
  /** Unsubmitted choices survive tab switches; never written to disk. */
  questionDrafts: Record<string, QuestionDraft>
  saveQuestionDraft(key: string, draft: QuestionDraft | null): void
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
  leaveSettings(): void
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
  /** Audio-first session view. Entering forces spoken replies on; leaving restores the prior choice. */
  voiceMode: boolean
  setVoiceMode(on: boolean): void
}

/** voiceEnabled as it was before voice mode forced it on; null outside voice mode. */
let voiceEnabledBeforeMode: boolean | null = null

export const useUi = create<UiState>((set, get) => ({
  route: { name: 'home' },
  settingsReturnRoute: { name: 'home' },
  settingsLocation: 'mac',
  setSettingsLocation: (settingsLocation) => set({ settingsLocation }),
  workspacePane: 'chat',
  modals: CLOSED,
  paletteOpen: false,
  voiceEnabled: false,
  setVoiceEnabled: (voiceEnabled) => set({ voiceEnabled }),
  voiceMode: false,
  setVoiceMode: (on) => {
    if (on === get().voiceMode) return
    if (on) {
      voiceEnabledBeforeMode = get().voiceEnabled
      set({ voiceMode: true, voiceEnabled: true })
    } else {
      set({ voiceMode: false, voiceEnabled: voiceEnabledBeforeMode ?? get().voiceEnabled })
      voiceEnabledBeforeMode = null
    }
  },
  draft: null,
  setDraft: (draft) => set({ draft }),
  draftBySession: {},
  questionDrafts: {},
  saveQuestionDraft: (key, draft) =>
    set((state) => {
      const questionDrafts = { ...state.questionDrafts }
      if (draft === null) delete questionDrafts[key]
      else questionDrafts[key] = draft
      return { questionDrafts }
    }),
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
  navigate: (route) =>
    set((state) => {
      const enteringSettings = route.name === 'settings' && state.route.name !== 'settings'
      let settingsLocation = state.settingsLocation
      if (enteringSettings) {
        const workspaceId = state.route.name === 'workspace' ? state.route.workspaceId : null
        const workspace = Object.values(useProjects.getState().workspacesByProject)
          .flat()
          .find((row) => row.id === workspaceId)
        settingsLocation = workspace?.cloud ? 'cloud' : 'mac'
      }
      return {
        route,
        settingsLocation,
        settingsReturnRoute:
          route.name === 'settings' && state.route.name !== 'settings'
            ? state.route
            : state.settingsReturnRoute
      }
    }),
  leaveSettings: () => {
    if (get().route.name !== 'settings') return
    const route = get().settingsReturnRoute
    const exists =
      route.name !== 'workspace' ||
      Object.values(useProjects.getState().workspacesByProject).some((rows) =>
        rows.some((workspace) => workspace.id === route.workspaceId)
      )
    get().navigate(exists ? route : { name: 'home' })
  },
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
