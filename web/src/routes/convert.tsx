import { createFileRoute } from "@tanstack/react-router"
import * as React from "react"
import { motion } from "motion/react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowDataTransferHorizontalIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Download04Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Dropzone } from "@/components/dropzone"
import { ToolHeader } from "@/components/tool-header"
import { cn } from "@/lib/utils"
import {
  type CompressionProgress,
  type ConvertTarget,
  convertFiles,
  downloadBlob,
  formatBytes,
} from "@/lib/api"
import { useConvertStore } from "@/stores/convert"
import { useHandoffStore } from "@/stores/handoff"

export const Route = createFileRoute("/convert")({ component: ConvertPage })

const PHASE_LABELS: Record<CompressionProgress["phase"], string> = {
  uploading: "Uploading",
  queued: "In line",
  processing: "Converting",
  downloading: "Downloading",
}

type SourceKind = "pdf" | "image" | "docx" | "md" | "html" | "txt"

const EXTENSION_KINDS: Record<string, SourceKind> = {
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  docx: "docx",
  md: "md",
  markdown: "md",
  html: "html",
  htm: "html",
  txt: "txt",
}

const KIND_LABELS: Record<SourceKind, string> = {
  pdf: "PDF",
  image: "Image",
  docx: "Word",
  md: "Markdown",
  html: "HTML",
  txt: "Text",
}

const TARGETS_BY_KIND: Record<SourceKind, Array<{ value: ConvertTarget; label: string; hint: string }>> = {
  pdf: [
    { value: "png", label: "PNG images", hint: "Each page as a PNG, zipped" },
    { value: "jpeg", label: "JPEG images", hint: "Each page as a JPEG, zipped" },
    { value: "docx", label: "Word", hint: "Editable .docx — best on text PDFs" },
    { value: "md", label: "Markdown", hint: "Plain text extraction" },
    { value: "txt", label: "Text", hint: "Plain text extraction" },
  ],
  image: [{ value: "pdf", label: "PDF", hint: "Combine images into one PDF, in order" }],
  docx: [
    { value: "pdf", label: "PDF", hint: "High-fidelity via LibreOffice" },
    { value: "md", label: "Markdown", hint: "" },
    { value: "html", label: "HTML", hint: "" },
    { value: "txt", label: "Text", hint: "" },
  ],
  md: [
    { value: "pdf", label: "PDF", hint: "Rendered document" },
    { value: "html", label: "HTML", hint: "" },
    { value: "docx", label: "Word", hint: "" },
    { value: "txt", label: "Text", hint: "" },
  ],
  html: [
    { value: "pdf", label: "PDF", hint: "Rendered page" },
    { value: "md", label: "Markdown", hint: "" },
    { value: "docx", label: "Word", hint: "" },
    { value: "txt", label: "Text", hint: "" },
  ],
  txt: [
    { value: "pdf", label: "PDF", hint: "Monospace document" },
    { value: "md", label: "Markdown", hint: "" },
    { value: "html", label: "HTML", hint: "" },
    { value: "docx", label: "Word", hint: "" },
  ],
}

const DPI_OPTIONS = [
  { value: 72, label: "72 dpi", hint: "Small, for screens" },
  { value: 150, label: "150 dpi", hint: "Balanced" },
  { value: 300, label: "300 dpi", hint: "Print quality" },
]

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,.md,.markdown,.html,.htm,.txt"

function kindOf(file: File): SourceKind | null {
  const ext = file.name.toLowerCase().split(".").pop() ?? ""
  return EXTENSION_KINDS[ext] ?? null
}

function ConvertPage() {
  const { files, target, dpi, status, result, error, progress } = useConvertStore()
  const inputRef = React.useRef<HTMLInputElement>(null)

  const sourceKind = files.length > 0 ? kindOf(files[0]) : null
  const targets = sourceKind ? TARGETS_BY_KIND[sourceKind] : []
  const isImageBatch = sourceKind === "image"
  const loading = status === "loading"

  const addFiles = React.useCallback((incoming: FileList | File[] | null) => {
    if (!incoming) return
    const supported = Array.from(incoming).filter((file) => kindOf(file) !== null)
    if (supported.length === 0) return
    useConvertStore.setState((state) => {
      const firstKind = state.files.length > 0 ? kindOf(state.files[0]) : kindOf(supported[0])
      if (firstKind === "image" && state.files.length > 0) {
        const incomingImages = supported.filter((f) => kindOf(f) === "image")
        if (incomingImages.length === 0) return state
        const seen = new Set(state.files.map((f) => `${f.name}:${f.size}`))
        const unique: File[] = []
        for (const file of incomingImages) {
          const key = `${file.name}:${file.size}`
          if (seen.has(key)) continue
          seen.add(key)
          unique.push(file)
        }
        return { files: [...state.files, ...unique], target: "pdf" as ConvertTarget, status: "idle" as const, result: null, error: null }
      }
      // Fresh selection (or replacing a non-image): single non-image file, or an all-image batch.
      const incomingImages = supported.filter((f) => kindOf(f) === "image")
      if (incomingImages.length === supported.length && supported.length > 0) {
        return { files: incomingImages, target: "pdf" as ConvertTarget, status: "idle" as const, result: null, error: null }
      }
      const file = supported[0]
      const kind = kindOf(file)!
      return { files: [file], target: kind === "image" ? ("pdf" as ConvertTarget) : null, status: "idle" as const, result: null, error: null }
    })
  }, [])

  // Adopt files handed off from the landing page — only into an empty, idle
  // page, and only take() when adopting so unclaimed files survive for a
  // different tool choice.
  React.useEffect(() => {
    const state = useConvertStore.getState()
    if (state.files.length > 0 || state.status !== "idle") return
    const pending = useHandoffStore.getState().take()
    if (pending.length > 0) addFiles(pending)
    // Intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const removeFile = (index: number) => {
    useConvertStore.setState((state) => {
      const files = state.files.filter((_, i) => i !== index)
      return { files, target: files.length === 0 ? null : state.target, status: "idle" as const, result: null }
    })
  }

  const moveFile = (index: number, delta: -1 | 1) => {
    useConvertStore.setState((state) => {
      const to = index + delta
      if (to < 0 || to >= state.files.length) return state
      const next = [...state.files]
      ;[next[index], next[to]] = [next[to], next[index]]
      return { files: next, status: "idle" as const, result: null }
    })
  }

  const handleConvert = async () => {
    const current = useConvertStore.getState()
    if (current.files.length === 0 || !current.target) return
    useConvertStore.setState({
      status: "loading",
      error: null,
      result: null,
      progress: { phase: "uploading", percent: 0 },
    })
    try {
      const converted = await convertFiles(
        current.files,
        current.target,
        current.target === "png" || current.target === "jpeg" ? current.dpi : null,
        (p) => useConvertStore.setState({ progress: p }),
      )
      useConvertStore.setState({ result: converted, status: "success" })
    } catch (err) {
      useConvertStore.setState({
        error: err instanceof Error ? err.message : "Something went wrong.",
        status: "error",
      })
    } finally {
      useConvertStore.setState({ progress: null })
    }
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0)

  return (
    <div className="pb-4">
      <ToolHeader
        icon={ArrowDataTransferHorizontalIcon}
        title="Convert"
        subtitle="PDF, Word, Markdown, HTML, text, and images — changed into each other."
      />

      <input
        ref={inputRef}
        type="file"
        accept={isImageBatch ? ".png,.jpg,.jpeg" : ACCEPT}
        multiple
        className="hidden"
        onChange={(event) => addFiles(event.target.files)}
      />

      <div className="mt-8 grid grid-cols-1 items-start gap-7 lg:grid-cols-[1fr_360px]">
        {/* ── Left: file(s) ── */}
        {files.length === 0 ? (
          <Dropzone
            multiple
            onFiles={addFiles}
            onPick={() => inputRef.current?.click()}
            title="Drop a file here"
            hint="PDF, Word, Markdown, HTML, text, or images"
          />
        ) : (
          <div className="rounded-[20px] border-2 border-ink bg-card p-[22px] shadow-block-lg">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-[13px] font-extrabold uppercase tracking-wide text-muted-ink">
                {KIND_LABELS[sourceKind!]} · {files.length} file{files.length > 1 ? "s" : ""}
                {isImageBatch && files.length > 1 ? " — combined top to bottom" : ""}
              </span>
              <span className="text-[13px] font-bold text-muted-ink">{formatBytes(totalSize)}</span>
            </div>

            <div className="flex flex-col gap-2.5">
              {files.map((file, index) => (
                <div
                  key={`${file.name}:${file.size}`}
                  className="flex items-center gap-3 rounded-[14px] border-2 border-ink bg-surface px-3 py-2.5"
                >
                  {isImageBatch && (
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] border-2 border-ink bg-soft-amber font-heading text-[15px] font-extrabold text-ink">
                      {index + 1}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-heading text-[15px] font-extrabold text-ink">
                      {file.name}
                    </div>
                    <div className="text-[13px] font-semibold text-muted-ink">
                      {formatBytes(file.size)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {isImageBatch && (
                      <>
                        <button
                          type="button"
                          aria-label={`Move ${file.name} up`}
                          disabled={index === 0 || loading}
                          onClick={() => moveFile(index, -1)}
                          className="press flex size-8 items-center justify-center rounded-[9px] border-2 border-ink text-ink disabled:opacity-30"
                        >
                          <HugeiconsIcon icon={ArrowUp01Icon} className="size-4" strokeWidth={2.4} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${file.name} down`}
                          disabled={index === files.length - 1 || loading}
                          onClick={() => moveFile(index, 1)}
                          className="press flex size-8 items-center justify-center rounded-[9px] border-2 border-ink text-ink disabled:opacity-30"
                        >
                          <HugeiconsIcon icon={ArrowDown01Icon} className="size-4" strokeWidth={2.4} />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      disabled={loading}
                      onClick={() => removeFile(index)}
                      className="press flex size-8 items-center justify-center rounded-[9px] border-2 border-ink text-ink disabled:opacity-30"
                    >
                      <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={2.4} />
                    </button>
                  </div>
                </div>
              ))}

              {isImageBatch && (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => inputRef.current?.click()}
                  className="flex items-center justify-center gap-2 rounded-[14px] border-2 border-dashed border-[#c9b89c] py-3 text-[13px] font-extrabold uppercase tracking-wide text-muted-ink transition-colors hover:border-ink hover:text-ink disabled:opacity-30"
                >
                  <HugeiconsIcon icon={Add01Icon} className="size-4" strokeWidth={2.4} />
                  Add more images
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Right: target picker — sticky on desktop so it stays in view ── */}
        <div className="rounded-[20px] border-2 border-ink bg-card p-6 shadow-block-lg sm:p-8 lg:sticky lg:top-7">
          <div className="mb-3.5 text-[13px] font-extrabold uppercase tracking-wide text-ink">
            Convert to
          </div>
          {targets.length === 0 ? (
            <p className="text-[14px] font-semibold text-muted-ink">
              Drop a file to see what it can become.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {targets.map((option) => {
                const selected = target === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={loading}
                    onClick={() => useConvertStore.setState({ target: option.value, status: "idle", result: null })}
                    className={cn(
                      "flex items-center gap-3.5 rounded-[14px] border-2 border-ink p-4 text-left transition-[background-color,box-shadow]",
                      selected ? "bg-surface shadow-amber-sm" : "bg-card hover:bg-surface",
                      "disabled:opacity-60",
                    )}
                  >
                    <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full border-2 border-ink">
                      {selected && <span className="size-2.5 rounded-full bg-amber" />}
                    </span>
                    <span className="flex-1">
                      <span className="block font-heading text-[17px] font-extrabold text-ink">
                        {option.label}
                      </span>
                      {option.hint && (
                        <span className="block text-[13px] font-semibold text-[#6b5f50]">
                          {option.hint}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {(target === "png" || target === "jpeg") && (
            <>
              <div className="mb-3.5 mt-6 text-[13px] font-extrabold uppercase tracking-wide text-ink">
                Resolution
              </div>
              <div className="flex gap-2.5">
                {DPI_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={loading}
                    onClick={() => useConvertStore.setState({ dpi: option.value })}
                    className={cn(
                      "flex-1 rounded-[12px] border-2 border-ink px-3 py-2.5 text-center",
                      dpi === option.value ? "bg-amber" : "bg-card hover:bg-surface",
                      "disabled:opacity-60",
                    )}
                  >
                    <span className="block font-heading text-[15px] font-extrabold text-ink">
                      {option.label}
                    </span>
                    <span className="block text-[12px] font-semibold text-[#6b5f50]">
                      {option.hint}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          <Button
            size="lg"
            onClick={handleConvert}
            disabled={files.length === 0 || !target || loading}
            className="mt-6 w-full"
          >
            {loading ? (
              <>
                <HugeiconsIcon icon={Loading03Icon} className="animate-spin" />
                Converting…
              </>
            ) : (
              "Convert"
            )}
          </Button>

          {/* Progress */}
          {loading && progress && (
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
              <div className="truncate font-heading text-lg font-extrabold text-ink">
                {result.filename}
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
