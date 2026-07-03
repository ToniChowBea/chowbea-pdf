/**
 * Client helpers for the Chowbea PDF API.
 *
 * Every tool submits a job to the queue and receives the result through the
 * shared submit → poll → download flow in `lib/jobs.ts`. These wrappers keep
 * the per-tool signatures the pages consume.
 */

import axios from "axios"

import type { JobAccepted, JobProgress } from "./jobs"
import { API_BASE_URL, runJobFlow } from "./jobs"

/** Compression presets exposed by the API; ordered smallest to highest quality. */
export const COMPRESSION_QUALITIES = ["screen", "ebook", "printer", "prepress"] as const

export type CompressionQuality = (typeof COMPRESSION_QUALITIES)[number]

/** Progress update for the UI — now includes the queued phase and position. */
export type CompressionProgress = JobProgress

export type CompressionPhase = CompressionProgress["phase"]

/** Result of a successful compression request. */
export interface CompressionResult {
  /** The compressed payload: a PDF for one input, or a ZIP for several. */
  blob: Blob
  /** Suggested download filename parsed from the response. */
  filename: string
  /** Combined size of the uploaded files, in bytes. */
  originalSize: number
  /** Combined size of the compressed output, in bytes. */
  compressedSize: number
}

/** POST a multipart form and report upload progress until the job is accepted. */
async function submitForm(
  path: string,
  form: FormData,
  onProgress?: (progress: JobProgress) => void,
): Promise<JobAccepted> {
  const response = await axios.post<JobAccepted>(`${API_BASE_URL}${path}`, form, {
    onUploadProgress: (event) => {
      if (!onProgress) return
      const percent = event.total ? (event.loaded / event.total) * 100 : null
      if (percent === null || percent < 100) {
        onProgress({ phase: "uploading", percent })
      }
    },
  })
  return response.data
}

/**
 * Compress one or more PDFs and return the resulting file plus size stats.
 *
 * @throws Error with the API's error detail when the request or job fails.
 */
export async function compressPdfs(
  files: File[],
  quality: CompressionQuality,
  onProgress?: (progress: CompressionProgress) => void,
): Promise<CompressionResult> {
  const form = new FormData()
  for (const file of files) {
    form.append("files", file)
  }
  form.append("quality", quality)

  const download = await runJobFlow({
    tool: "compress",
    submit: () => submitForm("/pdf/compress", form, onProgress),
    onProgress,
  })
  const fallback = files.length === 1 ? files[0].name : "compressed-pdfs.zip"
  return {
    blob: download.blob,
    filename: download.filename ?? fallback,
    originalSize: Number(download.headers["x-original-size"] ?? 0),
    compressedSize: Number(download.headers["x-compressed-size"] ?? download.blob.size),
  }
}

/** Result of a successful merge request. */
export interface MergeResult {
  /** The combined PDF. */
  blob: Blob
  /** Suggested download filename parsed from the response. */
  filename: string
}

/**
 * Merge two or more PDFs, in array order, into a single file.
 *
 * @throws Error with the API's error detail (e.g. a locked input) on failure.
 */
export async function mergePdfs(
  files: File[],
  onProgress?: (progress: CompressionProgress) => void,
): Promise<MergeResult> {
  const form = new FormData()
  for (const file of files) {
    form.append("files", file)
  }
  const download = await runJobFlow({
    tool: "merge",
    submit: () => submitForm("/pdf/merge", form, onProgress),
    onProgress,
  })
  return {
    blob: download.blob,
    filename: download.filename ?? "merged.pdf",
  }
}

/** Result of a successful unlock request. */
export interface UnlockResult {
  /** The unlocked PDF. */
  blob: Blob
  /** Suggested download filename parsed from the response. */
  filename: string
}

/**
 * Remove the password from a single PDF and return the unlocked file.
 *
 * @throws Error with the API's error detail (e.g. wrong password) on failure.
 */
export async function unlockPdf(
  file: File,
  password: string,
  onProgress?: (progress: CompressionProgress) => void,
): Promise<UnlockResult> {
  const form = new FormData()
  form.append("file", file)
  form.append("password", password)

  const download = await runJobFlow({
    tool: "unlock",
    submit: () => submitForm("/pdf/unlock", form, onProgress),
    onProgress,
  })
  return {
    blob: download.blob,
    filename: download.filename ?? `unlocked-${file.name}`,
  }
}

/** Encryption strengths exposed by the lock endpoint. */
export const ENCRYPTION_LEVELS = ["aes-256", "aes-128"] as const

export type EncryptionLevel = (typeof ENCRYPTION_LEVELS)[number]

/** Options for locking a PDF; permissions default to a sensible "view only". */
export interface LockOptions {
  password: string
  allowPrinting: boolean
  allowCopying: boolean
  allowEditing: boolean
  encryption: EncryptionLevel
}

/** Result of a successful lock request. */
export interface LockResult {
  /** The password-protected PDF. */
  blob: Blob
  /** Suggested download filename parsed from the response. */
  filename: string
}

/**
 * Add a password to a single PDF and return the protected file.
 *
 * @throws Error with the API's error detail (e.g. already protected) on failure.
 */
export async function lockPdf(
  file: File,
  options: LockOptions,
  onProgress?: (progress: CompressionProgress) => void,
): Promise<LockResult> {
  const form = new FormData()
  form.append("file", file)
  form.append("password", options.password)
  form.append("allow_printing", String(options.allowPrinting))
  form.append("allow_copying", String(options.allowCopying))
  form.append("allow_editing", String(options.allowEditing))
  form.append("encryption", options.encryption)

  const download = await runJobFlow({
    tool: "lock",
    submit: () => submitForm("/pdf/lock", form, onProgress),
    onProgress,
  })
  return {
    blob: download.blob,
    filename: download.filename ?? `locked-${file.name}`,
  }
}

/** One page in the rotate tool's payload: original index + clockwise degrees. */
export interface PageOp {
  index: number
  rotation: number
}

/** Result of a successful rotate request. */
export interface RotateResult {
  /** The rearranged PDF. */
  blob: Blob
  /** Suggested download filename parsed from the response. */
  filename: string
}

/**
 * Rotate and/or reorder a PDF's pages. `pages` is the complete new page
 * order; each entry names an original page index and a rotation to add.
 *
 * @throws Error with the API's error detail on failure.
 */
export async function rotatePdf(
  file: File,
  pages: PageOp[],
  onProgress?: (progress: CompressionProgress) => void,
): Promise<RotateResult> {
  const form = new FormData()
  form.append("file", file)
  form.append("pages", JSON.stringify(pages))
  const download = await runJobFlow({
    tool: "rotate",
    submit: () => submitForm("/pdf/rotate", form, onProgress),
    onProgress,
  })
  return {
    blob: download.blob,
    filename: download.filename ?? `rotated-${file.name}`,
  }
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/** Format a byte count as a human-readable string (e.g. "1.2 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, exponent)
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}
