import { create } from 'zustand'
import type { OrgOverview } from '../../shared/org'

interface OrganizationState {
  overview: OrgOverview | null
  error: string | null
  loading: boolean
  connection: number
  refresh(): Promise<void>
  reset(): void
}

let revision = 0

/** Cloud-only data is discarded as soon as this desktop leaves the organization. */
export const useOrganization = create<OrganizationState>((set) => ({
  overview: null,
  error: null,
  loading: false,
  connection: 0,
  async refresh() {
    const mine = ++revision
    set({ loading: true, error: null })
    try {
      const overview = await window.loom.org.get()
      if (mine === revision) set({ overview, loading: false })
    } catch (error) {
      if (mine === revision) set({ overview: null, error: String(error), loading: false })
    }
  },
  reset() {
    revision++
    set((state) => ({ overview: null, error: null, loading: false, connection: state.connection + 1 }))
  }
}))
