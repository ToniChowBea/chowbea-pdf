import { create } from "zustand"

import type { CompressionProgress, MergeResult } from "@/lib/api"
import type { ToolStatus } from "./status"

interface MergeState {
  files: File[]
  status: ToolStatus
  result: MergeResult | null
  error: string | null
  progress: CompressionProgress | null
  reset: () => void
}

const initialState = {
  files: [] as File[],
  status: "idle" as ToolStatus,
  result: null as MergeResult | null,
  error: null as string | null,
  progress: null as CompressionProgress | null,
}

/** Module-level store: survives route unmounts, so leaving the page mid-job
loses nothing — in-flight submit callbacks keep writing here. */
export const useMergeStore = create<MergeState>()((set) => ({
  ...initialState,
  reset: () => set(initialState),
}))
