import { create } from "zustand"

import type { CompressionProgress, SplitResult } from "@/lib/api"
import type { ToolStatus } from "./status"

export type SplitStep = "upload" | "mode" | "build" | "rename"
export type SplitMode = "extract" | "consecutive" | "every-n"

export interface SplitPart {
  /** 0-based page indexes in document order. */
  pages: number[]
}

interface SplitState {
  step: SplitStep
  file: File | null
  mode: SplitMode | null
  pageCount: number
  thumbnails: (string | null)[]
  /** Currently highlighted page indexes. */
  selection: number[]
  parts: SplitPart[]
  pagesPerFile: number
  status: ToolStatus
  result: SplitResult | null
  error: string | null
  progress: CompressionProgress | null
  /** Editable names on the rename step. */
  downloadNames: string[]
  reset: () => void
}

const initialState = {
  step: "upload" as SplitStep,
  file: null as File | null,
  mode: null as SplitMode | null,
  pageCount: 0,
  thumbnails: [] as (string | null)[],
  selection: [] as number[],
  parts: [] as SplitPart[],
  pagesPerFile: 10,
  status: "idle" as ToolStatus,
  result: null as SplitResult | null,
  error: null as string | null,
  progress: null as CompressionProgress | null,
  downloadNames: [] as string[],
}

/** Module-level store: survives route unmounts, so leaving the page mid-job
loses nothing — in-flight submit callbacks keep writing here. */
export const useSplitStore = create<SplitState>()((set) => ({
  ...initialState,
  reset: () => set(initialState),
}))
