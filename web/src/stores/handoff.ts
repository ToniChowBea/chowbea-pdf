import { create } from "zustand"

interface HandoffState {
  /** Files picked on the landing page, waiting for the user to choose a tool. */
  files: File[]
  /** One-shot handoff: return the pending files and empty the store. */
  take: () => File[]
  /** Selective handoff: remove and return up to `limit` files matching the
   * predicate; non-matching (and over-limit) files STAY pending so they
   * survive for a different tool choice — nothing is silently dropped. */
  takeMatching: (predicate: (file: File) => boolean, limit?: number) => File[]
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
  takeMatching: (predicate, limit = Number.POSITIVE_INFINITY) => {
    const taken: File[] = []
    const remaining: File[] = []
    for (const file of get().files) {
      if (taken.length < limit && predicate(file)) {
        taken.push(file)
      } else {
        remaining.push(file)
      }
    }
    if (taken.length > 0) {
      set({ files: remaining })
    }
    return taken
  },
}))
