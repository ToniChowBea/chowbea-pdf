import { create } from "zustand"

import type { CompressionProgress, RotateResult } from "@/lib/api"
import type { ToolStatus } from "./status"

/** One page card in the rotate grid. Moved here from the route so the store
can type its state without importing the (pdfjs-loading) route module. */
export interface PageCard {
  /** 0-based index of this page in the ORIGINAL document. */
  originalIndex: number
  /** Clockwise degrees added by the user; 0/90/180/270. */
  rotation: number
  /** Rendered thumbnail data URL, or null while still rendering. */
  thumbnail: string | null
}

interface RotateState {
  file: File | null
  cards: PageCard[]
  status: ToolStatus
  result: RotateResult | null
  error: string | null
  progress: CompressionProgress | null
  reset: () => void
}

const initialState = {
  file: null as File | null,
  cards: [] as PageCard[],
  status: "idle" as ToolStatus,
  result: null as RotateResult | null,
  error: null as string | null,
  progress: null as CompressionProgress | null,
}

/** Module-level store: survives route unmounts, so leaving the page mid-job
loses nothing — in-flight submit callbacks keep writing here. */
export const useRotateStore = create<RotateState>()((set) => ({
  ...initialState,
  reset: () => set(initialState),
}))
