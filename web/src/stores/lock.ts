import { create } from "zustand"

import type { CompressionProgress, EncryptionLevel, LockResult } from "@/lib/api"
import type { ToolStatus } from "./status"

interface LockPermissions {
  allowPrinting: boolean
  allowCopying: boolean
  allowEditing: boolean
}

interface LockState {
  file: File | null
  password: string
  confirm: string
  showNew: boolean
  showConfirm: boolean
  permissions: LockPermissions
  encryption: EncryptionLevel
  status: ToolStatus
  result: LockResult | null
  error: string | null
  progress: CompressionProgress | null
  reset: () => void
}

const initialState = {
  file: null as File | null,
  password: "",
  confirm: "",
  showNew: false,
  showConfirm: false,
  permissions: { allowPrinting: true, allowCopying: false, allowEditing: false },
  encryption: "aes-256" as EncryptionLevel,
  status: "idle" as ToolStatus,
  result: null as LockResult | null,
  error: null as string | null,
  progress: null as CompressionProgress | null,
}

/** Module-level store: survives route unmounts, so leaving the page mid-job
loses nothing — in-flight submit callbacks keep writing here. */
export const useLockStore = create<LockState>()((set) => ({
  ...initialState,
  reset: () => set(initialState),
}))
