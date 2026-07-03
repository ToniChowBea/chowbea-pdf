import { createFileRoute } from "@tanstack/react-router"
import * as React from "react"
import { motion } from "motion/react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowRight02Icon,
  Cancel01Icon,
  Download04Icon,
  Loading03Icon,
  Minimize01Icon,
  Pdf01Icon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Dropzone } from "@/components/dropzone"
import { ToolHeader } from "@/components/tool-header"
import { cn } from "@/lib/utils"
import { useCompressStore } from "@/stores/compress"
import { useHandoffStore } from "@/stores/handoff"
import {
  type CompressionProgress,
  type CompressionQuality,
  compressPdfs,
  downloadBlob,
  formatBytes,
} from "@/lib/api"

export const Route = createFileRoute("/compress")({ component: CompressPage })

const PHASE_LABELS: Record<CompressionProgress["phase"], string> = {
  uploading: "Uploading",
  queued: "In line",
  processing: "Compressing",
  downloading: "Downloading",
}

// Quality presets, mirroring the API enum but worded for humans.
const QUALITY_OPTIONS: Array<{
  value: CompressionQuality
  label: string
  hint: string
  dpi: string
}> = [
  { value: "ebook", label: "Recommended", hint: "Great quality, much smaller", dpi: "150 dpi" },
  { value: "screen", label: "Strong", hint: "Smallest — great for email", dpi: "72 dpi" },
  { value: "printer", label: "Light", hint: "Highest quality, light trim", dpi: "300 dpi" },
  { value: "prepress", label: "Maximum", hint: "Print-ready, barely trimmed", dpi: "300 dpi+" },
]

function CompressPage() {
  const { files, quality, status, result, error, progress } = useCompressStore()
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Merge newly picked files into state, keeping only PDFs and skipping duplicates.
  const addFiles = React.useCallback((incoming: FileList | File[] | null) => {
    if (!incoming) return
    const pdfs = Array.from(incoming).filter(
      (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
    )
    useCompressStore.setState((state) => {
      const seen = new Set(state.files.map((f) => `${f.name}:${f.size}`))
      const unique = pdfs.filter((f) => !seen.has(`${f.name}:${f.size}`))
      return { files: [...state.files, ...unique] }
    })
    useCompressStore.setState({ status: "idle", result: null, error: null })
  }, [])

  // Adopt files handed off from the landing page — only into an empty, idle
  // page, and only take() when adopting so unclaimed files survive for a
  // different tool choice.
  React.useEffect(() => {
    const state = useCompressStore.getState()
    if (state.files.length > 0 || state.status !== "idle") return
    const pending = useHandoffStore.getState().take()
    if (pending.length > 0) addFiles(pending)
    // Intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const removeFile = (index: number) => {
    useCompressStore.setState((state) => ({ files: state.files.filter((_, i) => i !== index) }))
    useCompressStore.setState({ status: "idle", result: null })
  }

  const handleCompress = async () => {
    if (files.length === 0) return
    useCompressStore.setState({ status: "loading", error: null, result: null, progress: { phase: "uploading", percent: 0 } })
    try {
      const compressed = await compressPdfs(
        useCompressStore.getState().files,
        useCompressStore.getState().quality,
        (p) => useCompressStore.setState({ progress: p }),
      )
      useCompressStore.setState({ result: compressed, status: "success" })
    } catch (err) {
      useCompressStore.setState({
        error: err instanceof Error ? err.message : "Something went wrong.",
        status: "error",
      })
    } finally {
      useCompressStore.setState({ progress: null })
    }
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0)
  const savedRatio =
    result && result.originalSize > 0
      ? Math.max(0, 1 - result.compressedSize / result.originalSize)
      : 0
  const hasFiles = files.length > 0

  return (
    <div className="pb-4">
      <ToolHeader
        icon={Minimize01Icon}
        title="Compress PDF"
        subtitle="Make the file smaller while keeping it sharp."
      />

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="hidden"
        onChange={(event) => addFiles(event.target.files)}
      />

      <div className="mt-8 grid grid-cols-1 items-start gap-7 lg:grid-cols-[360px_1fr]">
        {/* ── Left: files ── */}
        {!hasFiles ? (
          <Dropzone
            multiple
            onFiles={addFiles}
            onPick={() => inputRef.current?.click()}
            title="Drop PDFs here"
            hint="Multiple files supported"
          />
        ) : (
          <div className="rounded-[20px] border-2 border-ink bg-card p-[22px] shadow-block-lg">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-[13px] font-extrabold uppercase tracking-wide text-muted-ink">
                {files.length} file{files.length > 1 ? "s" : ""}
              </span>
              <span className="text-[13px] font-bold text-muted-ink">{formatBytes(totalSize)}</span>
            </div>

            <div className="flex flex-col gap-2.5">
              {files.map((file, index) => (
                <div
                  key={`${file.name}:${file.size}`}
                  className="flex items-center gap-3 rounded-[14px] border-2 border-ink bg-surface px-3 py-2.5"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] border-2 border-ink bg-soft-amber text-ink">
                    <HugeiconsIcon icon={Pdf01Icon} className="size-5" strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-heading text-[15px] font-extrabold text-ink">
                      {file.name}
                    </div>
                    <div className="text-[13px] font-semibold text-muted-ink">
                      {formatBytes(file.size)}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    disabled={status === "loading"}
                    onClick={() => removeFile(index)}
                    className="press flex size-8 shrink-0 items-center justify-center rounded-[9px] border-2 border-ink text-ink disabled:opacity-30"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={2.4} />
                  </button>
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

        {/* ── Right: settings — sticky on desktop so it stays in view beside long lists ── */}
        <div className="rounded-[20px] border-2 border-ink bg-card p-6 shadow-block-lg sm:p-8 lg:sticky lg:top-7">
          <div className="mb-3.5 text-[13px] font-extrabold uppercase tracking-wide text-ink">
            Compression level
          </div>
          <div className="flex flex-col gap-3">
            {QUALITY_OPTIONS.map((option) => {
              const selected = quality === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => useCompressStore.setState({ quality: option.value })}
                  className={cn(
                    "flex items-center gap-3.5 rounded-[14px] border-2 border-ink p-4 text-left transition-[background-color,box-shadow]",
                    selected ? "bg-surface shadow-amber-sm" : "bg-card hover:bg-surface",
                  )}
                >
                  <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full border-2 border-ink">
                    {selected && <span className="size-2.5 rounded-full bg-amber" />}
                  </span>
                  <span className="flex-1">
                    <span className="block font-heading text-[17px] font-extrabold text-ink">
                      {option.label}
                    </span>
                    <span className="block text-[13px] font-semibold text-[#6b5f50]">
                      {option.hint}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "rounded-full border-2 border-ink px-3 py-1 text-[13px] font-extrabold text-ink",
                      selected ? "bg-amber" : "bg-card",
                    )}
                  >
                    {option.dpi}
                  </span>
                </button>
              )
            })}
          </div>

          <Button
            size="lg"
            onClick={handleCompress}
            disabled={!hasFiles || status === "loading"}
            className="mt-6 w-full"
          >
            {status === "loading" ? (
              <>
                <HugeiconsIcon icon={Loading03Icon} className="animate-spin" />
                Compressing…
              </>
            ) : (
              <>
                <HugeiconsIcon icon={Minimize01Icon} strokeWidth={2.2} />
                Compress{hasFiles ? ` ${files.length} file${files.length > 1 ? "s" : ""}` : ""}
              </>
            )}
          </Button>

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
              <div className="flex flex-wrap items-center gap-3.5">
                <span className="font-heading text-xl font-extrabold text-ink">
                  {formatBytes(result.originalSize)}
                </span>
                <HugeiconsIcon icon={ArrowRight02Icon} className="size-5 text-ink" strokeWidth={2.4} />
                <span className="font-heading text-xl font-extrabold text-ink">
                  {formatBytes(result.compressedSize)}
                </span>
                <span className="ml-auto rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-extrabold uppercase tracking-wide text-cream">
                  {Math.round(savedRatio * 100)}% smaller
                </span>
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
