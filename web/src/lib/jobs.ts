/**
 * Job-queue machinery shared by every tool: submit → poll → download.
 *
 * The API returns 202 + a job id; the browser polls `GET /jobs/{id}` (which
 * carries the queue position) and downloads the result when the job is done.
 */

import axios from "axios"

// Base URL of the API, injected at build time by Vite.
export const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000"

export type JobState = "queued" | "processing" | "done" | "failed"

export interface JobAccepted {
  job_id: string
  position: number | null
  queue_size: number
}

export interface JobStatusResponse {
  id: string
  tool: string
  status: JobState
  position: number | null
  queue_size: number
  error: string | null
  file_count: number
  total_bytes: number
  created_at: number
}

export interface QueueBoardEntry {
  id_prefix: string
  tool: string
  file_count: number
  total_bytes: number
  created_at: number
}

export interface QueueBoard {
  concurrency: number
  processing: QueueBoardEntry[]
  waiting: QueueBoardEntry[]
  jobs_completed: number
}

/** Progress update for the UI; `percent` is null when the phase is indeterminate. */
export interface JobProgress {
  phase: "uploading" | "queued" | "processing" | "downloading"
  percent: number | null
  position?: number | null
  queueSize?: number
}

/** Normalize any axios/API failure into an Error carrying the API's detail. */
export async function toApiError(err: unknown): Promise<Error> {
  if (axios.isAxiosError(err) && err.response) {
    let detail = `Request failed with status ${err.response.status}`
    try {
      const data = err.response.data
      const text = data instanceof Blob ? await data.text() : JSON.stringify(data)
      const parsed = JSON.parse(text)
      if (typeof parsed?.detail === "string") detail = parsed.detail
    } catch {
      // Non-JSON error body; keep the default message.
    }
    return new Error(detail)
  }
  return err instanceof Error ? err : new Error("Something went wrong.")
}

export async function fetchJobStatus(jobId: string): Promise<JobStatusResponse> {
  const response = await axios.get<JobStatusResponse>(`${API_BASE_URL}/jobs/${jobId}`)
  return response.data
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Poll a job until it finishes. Resolves with the final "done" status and
 * rejects with the job's error message when it fails or expires.
 */
export async function waitForJob(
  jobId: string,
  opts: {
    getStatus?: (jobId: string) => Promise<JobStatusResponse>
    delayMs?: number
    onProgress?: (progress: JobProgress) => void
  } = {},
): Promise<JobStatusResponse> {
  const { getStatus = fetchJobStatus, delayMs = 2000, onProgress } = opts
  let consecutiveFailures = 0
  for (;;) {
    let current: JobStatusResponse
    try {
      current = await getStatus(jobId)
      consecutiveFailures = 0
    } catch (err) {
      if (axios.isAxiosError(err) && err.response && err.response.status < 500) throw err
      consecutiveFailures += 1
      if (consecutiveFailures >= 3) throw err
      await sleep(delayMs)
      continue
    }
    if (current.status === "done") return current
    if (current.status === "failed") {
      throw new Error(current.error ?? "The job failed.")
    }
    if (current.status === "queued") {
      onProgress?.({
        phase: "queued",
        percent: null,
        position: current.position,
        queueSize: current.queue_size,
      })
    } else {
      onProgress?.({ phase: "processing", percent: null })
    }
    await sleep(delayMs)
  }
}

export interface JobDownload {
  blob: Blob
  filename: string | undefined
  headers: Record<string, string | undefined>
}

export async function downloadJobResult(
  jobId: string,
  onProgress?: (progress: JobProgress) => void,
): Promise<JobDownload> {
  const response = await axios.get<Blob>(`${API_BASE_URL}/jobs/${jobId}/download`, {
    responseType: "blob",
    onDownloadProgress: (event) => {
      onProgress?.({
        phase: "downloading",
        percent: event.total ? (event.loaded / event.total) * 100 : null,
      })
    },
  })
  const disposition = response.headers["content-disposition"] as string | undefined
  const match = disposition ? /filename="?([^"]+)"?/.exec(disposition) : null
  return {
    blob: response.data,
    filename: match?.[1],
    headers: {
      "x-original-size": response.headers["x-original-size"],
      "x-compressed-size": response.headers["x-compressed-size"],
    },
  }
}

/** Submit, wait, download — the whole queued-job round trip for one tool. */
export async function runJobFlow(options: {
  submit: () => Promise<JobAccepted>
  tool: string
  onProgress?: (progress: JobProgress) => void
}): Promise<JobDownload> {
  try {
    const accepted = await options.submit()
    rememberJob(accepted.job_id, options.tool)
    options.onProgress?.({
      phase: "queued",
      percent: null,
      position: accepted.position,
      queueSize: accepted.queue_size,
    })
    await waitForJob(accepted.job_id, { onProgress: options.onProgress })
    return await downloadJobResult(accepted.job_id, options.onProgress)
  } catch (err) {
    throw await toApiError(err)
  }
}

export async function fetchQueueBoard(): Promise<QueueBoard> {
  const response = await axios.get<QueueBoard>(`${API_BASE_URL}/queue`)
  return response.data
}

// ── Local memory of "my" jobs, so the queue board can highlight them. ──

const JOBS_STORAGE_KEY = "chowbea:jobs"

interface RememberedJob {
  id: string
  tool: string
  at: number
}

function readRemembered(): RememberedJob[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(JOBS_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as RememberedJob[]) : []
  } catch {
    return []
  }
}

export function rememberJob(jobId: string, tool: string): void {
  if (typeof window === "undefined") return
  // Keep only the most recent handful; results expire server-side in 30 min.
  const kept = readRemembered().slice(-19)
  kept.push({ id: jobId, tool, at: Date.now() })
  window.localStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify(kept))
}

export function recallJobIds(): string[] {
  return readRemembered().map((job) => job.id)
}
