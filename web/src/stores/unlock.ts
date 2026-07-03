import { create } from "zustand"

import type { CompressionProgress, UnlockResult } from "@/lib/api"
import type { ToolStatus } from "./status"

interface UnlockState {
  file: File | null
  password: string
  showPassword: boolean
  status: ToolStatus
  result: UnlockResult | null
  error: string | null
  progress: CompressionProgress | null
  reset: () => void
}

const initialState = {
  file: null as File | null,
  password: "",
  showPassword: false,
  status: "idle" as ToolStatus,
  result: null as UnlockResult | null,
  error: null as string | null,
  progress: null as CompressionProgress | null,
}

/** Module-level store: survives route unmounts, so leaving the page mid-job
loses nothing — in-flight submit callbacks keep writing here. */
export const useUnlockStore = create<UnlockState>()((set) => ({
  ...initialState,
  reset: () => set(initialState),
}))
