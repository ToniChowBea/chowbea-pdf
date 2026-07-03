import { createFileRoute } from "@tanstack/react-router"
import * as React from "react"
import { motion } from "motion/react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Download04Icon,
  Layers01Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Dropzone } from "@/components/dropzone"
import { ToolHeader } from "@/components/tool-header"
import { useMergeStore } from "@/stores/merge"
import { useHandoffStore } from "@/stores/handoff"
import {
  type CompressionProgress,
  downloadBlob,
  formatBytes,
  mergePdfs,
} from "@/lib/api"

export const Route = createFileRoute("/merge")({ component: MergePage })

const PHASE_LABELS: Record<CompressionProgress["phase"], string> = {
  uploading: "Uploading",
  queued: "In line",
  processing: "Merging",
  downloading: "Downloading",
}

function MergePage() {
  const { files, status, result, error, progress } = useMergeStore()
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Merge newly picked files into state, keeping only PDFs and skipping duplicates.
  const addFiles = React.useCallback((incoming: FileList | File[] | null) => {
    if (!incoming) return
    const pdfs = Array.from(incoming).filter(
      (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
    )
    useMergeStore.setState((state) => {
      const seen = new Set(state.files.map((f) => `${f.name}:${f.size}`))
      const unique: File[] = []
      for (const file of pdfs) {
        const key = `${file.name}:${file.size}`
        if (seen.has(key)) continue
        seen.add(key)
        unique.push(file)
      }
      return { files: [...state.files, ...unique] }
    })
    useMergeStore.setState({ status: "idle", result: null, error: null })
  }, [])

  // Adopt files handed off from the landing page — only into an empty, idle
  // page, and only take() when adopting so unclaimed files survive for a
  // different tool choice.
  React.useEffect(() => {
    const state = useMergeStore.getState()
    if (state.files.length > 0 || state.status !== "idle") return
    const pending = useHandoffStore.getState().take()
    if (pending.length > 0) addFiles(pending)
    // Intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const removeFile = (index: number) => {
    useMergeStore.setState((state) => ({ files: state.files.filter((_, i) => i !== index) }))
    useMergeStore.setState({ status: "idle", result: null })
  }

  // Swap a file with its neighbour; list order is merge order.
  const moveFile = (index: number, delta: -1 | 1) => {
    useMergeStore.setState((state) => {
      const target = index + delta
      if (target < 0 || target >= state.files.length) return { files: state.files }
      const next = [...state.files]
      ;[next[index], next[target]] = [next[target], next[index]]
      return { files: next }
    })
    useMergeStore.setState({ status: "idle", result: null })
  }

  const handleMerge = async () => {
    if (files.length < 2) return
    useMergeStore.setState({ status: "loading", error: null, result: null, progress: { phase: "uploading", percent: 0 } })
    try {
      const merged = await mergePdfs(
        useMergeStore.getState().files,
        (p) => useMergeStore.setState({ progress: p }),
      )
      useMergeStore.setState({ result: merged, status: "success" })
    } catch (err) {
      useMergeStore.setState({
        error: err instanceof Error ? err.message : "Something went wrong.",
        status: "error",
      })
    } finally {
      useMergeStore.setState({ progress: null })
    }
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0)
  const hasEnough = files.length >= 2

  return (
    <div className="pb-4">
      <ToolHeader
        icon={Layers01Icon}
        title="Merge PDF"
        subtitle="Combine files into one — the order below is the page order."
      />

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="hidden"
        onChange={(event) => addFiles(event.target.files)}
      />

      <div className="mt-8 grid grid-cols-1 items-start gap-7 lg:grid-cols-[1fr_360px]">
        {/* ── Left: ordered files ── */}
        {files.length === 0 ? (
          <Dropzone
            multiple
            onFiles={addFiles}
            onPick={() => inputRef.current?.click()}
            title="Drop PDFs here"
            hint="At least two files"
          />
        ) : (
          <div className="rounded-[20px] border-2 border-ink bg-card p-[22px] shadow-block-lg">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-[13px] font-extrabold uppercase tracking-wide text-muted-ink">
                {files.length} file{files.length > 1 ? "s" : ""} — merged top to bottom
              </span>
              <span className="text-[13px] font-bold text-muted-ink">{formatBytes(totalSize)}</span>
            </div>

            <div className="flex flex-col gap-2.5">
              {files.map((file, index) => (
                <div
                  key={`${file.name}:${file.size}`}
                  className="flex items-center gap-3 rounded-[14px] border-2 border-ink bg-surface px-3 py-2.5"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] border-2 border-ink bg-soft-amber font-heading text-[15px] font-extrabold text-ink">
                    {index + 1}
                  </span>
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] border-2 border-ink bg-card text-ink">
                    <HugeiconsIcon icon={Layers01Icon} className="size-5" strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-heading text-[15px] font-extrabold text-ink">
                      {file.name}
                    </div>
                    <div className="text-[13px] font-semibold text-muted-ink">
                      {formatBytes(file.size)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      aria-label={`Move ${file.name} up`}
                      disabled={index === 0 || status === "loading"}
                      onClick={() => moveFile(index, -1)}
                      className="press flex size-8 items-center justify-center rounded-[9px] border-2 border-ink text-ink disabled:opacity-30"
                    >
                      <HugeiconsIcon icon={ArrowUp01Icon} className="size-4" strokeWidth={2.4} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${file.name} down`}
                      disabled={index === files.length - 1 || status === "loading"}
                      onClick={() => moveFile(index, 1)}
                      className="press flex size-8 items-center justify-center rounded-[9px] border-2 border-ink text-ink disabled:opacity-30"
                    >
                      <HugeiconsIcon icon={ArrowDown01Icon} className="size-4" strokeWidth={2.4} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      disabled={status === "loading"}
                      onClick={() => removeFile(index)}
                      className="press flex size-8 items-center justify-center rounded-[9px] border-2 border-ink text-ink disabled:opacity-30"
                    >
                      <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={2.4} />
                    </button>
                  </div>
                </div>
              ))}

              <button
                type="button"
                disabled={status === "loading"}
                onClick={() => inputRef.current?.click()}
                className="flex items-center justify-center gap-2 rounded-[14px] border-2 border-dashed border-[#c9b89c] py-3 text-[13px] font-extrabold uppercase tracking-wide text-muted-ink transition-colors hover:border-ink hover:text-ink disabled:opacity-30"
              >
                <HugeiconsIcon icon={Add01Icon} className="size-4" strokeWidth={2.4} />
                Add more files
              </button>
            </div>
          </div>
        )}

        {/* ── Right: action — sticky on desktop so it stays in view beside long lists ── */}
        <div className="rounded-[20px] border-2 border-ink bg-card p-6 shadow-block-lg sm:p-8 lg:sticky lg:top-7">
          <div className="mb-3.5 text-[13px] font-extrabold uppercase tracking-wide text-ink">
            Merge
          </div>
          <p className="text-[14px] font-semibold text-muted-ink">
            Pages are combined losslessly, in the order shown. Locked PDFs must be
            unlocked first.
          </p>

          <Button
            size="lg"
            onClick={handleMerge}
            disabled={!hasEnough || status === "loading"}
            className="mt-6 w-full"
          >
            {status === "loading" ? (
              <>
                <HugeiconsIcon icon={Loading03Icon} className="animate-spin" />
                Merging…
              </>
            ) : (
              <>Merge{files.length > 0 ? ` ${files.length} file${files.length > 1 ? "s" : ""}` : ""}</>
            )}
          </Button>
          {!hasEnough && files.length === 1 && (
            <p className="mt-3 text-[13px] font-semibold text-muted-ink">
              Add at least one more PDF to merge.
            </p>
          )}

          {/* Progress */}
          {status === "loading" && progress && (
            <div className="mt-5 flex flex-col gap-2">
              <div className="flex items-center justify-between text-[13px] font-extrabold uppercase tracking-wide text-muted-ink">
                <span>
                  {progress.phase === "queued" && progress.position != null
                    ? `In line — #${progress.position}`
                    : PHASE_LABELS[progress.phase]}
                  …
                </span>
                {progress.percent !== null && (
                  <span className="tabular-nums text-ink">{Math.round(progress.percent)}%</span>
                )}
              </div>
              {progress.percent !== null ? (
                <Progress value={progress.percent} />
              ) : (
                <div className="h-2.5 w-full overflow-hidden rounded-full border-2 border-ink bg-surface">
                  <div className="animate-indeterminate h-full w-2/5 rounded-full bg-amber" />
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {status === "error" && error && (
            <p className="mt-5 rounded-[12px] border-2 border-destructive bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">
              {error}
            </p>
          )}

          {/* Result */}
          {status === "success" && result && (
            <motion.div
              className="mt-5 rounded-[16px] border-2 border-ink bg-cream p-5 shadow-amber-sm"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35 }}
            >
              <div className="font-heading text-lg font-extrabold text-ink">
                {files.length} files → 1 PDF
              </div>
              <Button
                variant="outline"
                size="lg"
                className="mt-4 w-full"
                onClick={() => downloadBlob(result.blob, result.filename)}
              >
                <HugeiconsIcon icon={Download04Icon} strokeWidth={2.2} />
                Download
              </Button>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  )
}
