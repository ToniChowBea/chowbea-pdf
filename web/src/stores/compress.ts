import { create } from "zustand"

import type {
  CompressionProgress,
  CompressionQuality,
  CompressionResult,
} from "@/lib/api"
import type { ToolStatus } from "./status"

interface CompressState {
  files: File[]
  quality: CompressionQuality
  status: ToolStatus
  result: CompressionResult | null
  error: string | null
  progress: CompressionProgress | null
  reset: () => void
}

const initialState = {
  files: [] as File[],
  quality: "ebook" as CompressionQuality,
  status: "idle" as ToolStatus,
  result: null as CompressionResult | null,
  error: null as string | null,
  progress: null as CompressionProgress | null,
}

/** Module-level store: survives route unmounts, so leaving the page mid-job
loses nothing — in-flight submit callbacks keep writing here. */
export const useCompressStore = create<CompressState>()((set) => ({
  ...initialState,
  reset: () => set(initialState),
}))
