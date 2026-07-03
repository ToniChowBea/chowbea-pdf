import { create } from "zustand"

interface HandoffState {
  /** Files picked on the landing page, waiting for the user to choose a tool. */
  files: File[]
  /** One-shot handoff: return the pending files and empty the store. */
  take: () => File[]
}

/** Module-level store: survives navigation from the landing page to a tool. */
export const useHandoffStore = create<HandoffState>()((set, get) => ({
  files: [],
  take: () => {
    const files = get().files
    if (files.length > 0) {
      set({ files: [] })
    }
    return files
  },
}))
