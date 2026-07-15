import { createFileRoute } from "@tanstack/react-router"
import * as React from "react"
import { motion } from "motion/react"
import { HugeiconsIcon } from "@hugeicons/react"
import type { IconSvgElement } from "@hugeicons/react"
import {
  ArrowLeft01Icon,
  Cancel01Icon,
  CheckmarkSquare02Icon,
  Download04Icon,
  Files01Icon,
  Grid3X3Icon,
  Loading03Icon,
  PlusSignIcon,
  ScissorIcon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Dropzone } from "@/components/dropzone"
import { ToolHeader } from "@/components/tool-header"
import { isPdfFile } from "@/lib/supported-files"
import { cn } from "@/lib/utils"
import { type SplitMode, type SplitPart, useSplitStore } from "@/stores/split"
import { useHandoffStore } from "@/stores/handoff"
import { type CompressionProgress, downloadBlob, formatBytes, splitPdf } from "@/lib/api"
import { renameZipEntries } from "@/lib/rename-zip"
import {
  assignedPageSet,
  defaultPartFilenames,
  formatPageRange,
  hasDuplicateFilenames,
  isContiguousFrom,
  nextFrontier,
  normalizePdfFilename,
  partsFromEveryN,
  selectionToSortedPages,
} from "@/lib/split-parts"

export const Route = createFileRoute("/split")({ component: SplitPage })

const MAX_PAGES = 300

const PHASE_LABELS: Record<CompressionProgress["phase"], string> = {
  uploading: "Uploading",
  queued: "In line",
  processing: "Splitting",
  downloading: "Downloading",
}

// Cancellation token for in-flight thumbnail rendering. Module scope: a
// remount must still be able to invalidate a previous file's render run.
const renderRun = { current: 0 }

/** Render every page to a small data-URL thumbnail, reporting one at a time.

`onCount` fires as soon as the page count is known (before any rendering), so
the gallery can show placeholder tiles while thumbnails stream in. */
async function renderThumbnails(
  file: File,
  onCount: (pageCount: number) => void,
  onPage: (index: number, dataUrl: string) => void,
  isCancelled: () => boolean,
): Promise<number> {
  const pdfjs = await import("pdfjs-dist")
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() })
  try {
    const doc = await loadingTask.promise
    if (doc.numPages > MAX_PAGES) return doc.numPages
    onCount(doc.numPages)
    for (let i = 0; i < doc.numPages; i++) {
      if (isCancelled()) break
      const page = await doc.getPage(i + 1)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: 150 / base.width })
      const canvas = document.createElement("canvas")
      canvas.width = viewport.width
      canvas.height = viewport.height
      const context = canvas.getContext("2d")
      if (!context) break
      await page.render({ canvas, viewport }).promise
      onPage(i, canvas.toDataURL())
    }
    return doc.numPages
  } finally {
    await loadingTask.destroy()
  }
}

const MODES: Array<{ mode: SplitMode; icon: IconSvgElement; title: string; description: string }> = [
  {
    mode: "extract",
    icon: CheckmarkSquare02Icon,
    title: "Extract pages",
    description: "Pick the pages you want. Each group becomes its own PDF. Other pages are left out.",
  },
  {
    mode: "consecutive",
    icon: ScissorIcon,
    title: "Split into parts",
    description: "Select page ranges in order until the whole document is covered.",
  },
  {
    mode: "every-n",
    icon: Grid3X3Icon,
    title: "Split every N pages",
    description: "Break the PDF into equal chunks (for example, every 10 pages).",
  },
]

function ModeCard({
  icon,
  title,
  description,
  onSelect,
}: {
  icon: IconSvgElement
  title: string
  description: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex flex-col items-start gap-4 rounded-[18px] border-2 border-ink bg-card p-6 text-left shadow-block transition-[transform,box-shadow] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-block-lg active:translate-x-[5px] active:translate-y-[5px] active:shadow-none"
    >
      <span className="flex size-12 items-center justify-center rounded-[13px] border-2 border-ink bg-amber text-ink">
        <HugeiconsIcon icon={icon} className="size-6" strokeWidth={2.2} />
      </span>
      <div>
        <h3 className="font-heading text-lg font-extrabold text-ink">{title}</h3>
        <p className="mt-1 text-[14px] font-semibold text-muted-ink">{description}</p>
      </div>
    </button>
  )
}

function PageThumb({
  index,
  thumbnail,
  selected,
  disabled,
  badge,
  onPointerDown,
  onPointerEnter,
}: {
  index: number
  thumbnail: string | null
  selected: boolean
  disabled: boolean
  badge?: string
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerEnter: () => void
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      className={cn(
        "flex select-none flex-col gap-1.5 rounded-[12px] border-2 p-1.5 transition-colors",
        disabled
          ? "cursor-not-allowed border-ink/20 bg-surface opacity-50"
          : selected
            ? "cursor-pointer border-ink bg-soft-amber shadow-block-sm"
            : "cursor-pointer border-ink bg-card hover:bg-surface",
      )}
    >
      <div className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded-[8px] border-2 border-ink bg-white">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt={`Page ${index + 1}`}
            className="max-h-full max-w-full"
            draggable={false}
          />
        ) : (
          <HugeiconsIcon icon={Loading03Icon} className="size-4 animate-spin text-muted-ink" />
        )}
      </div>
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[11px] font-extrabold text-ink">{index + 1}</span>
        {badge ? (
          <span className="rounded-full bg-ink px-1.5 py-0.5 text-[10px] font-extrabold uppercase text-cream">
            {badge}
          </span>
        ) : (
          selected && (
            <HugeiconsIcon icon={CheckmarkSquare02Icon} className="size-3.5 text-ink" strokeWidth={2.4} />
          )
        )}
      </div>
    </div>
  )
}

/** 1-based label for a part's pages — a plain range when contiguous, an
explicit list otherwise (extract allows non-contiguous selections). */
function partLabel(pages: number[]): string {
  const sorted = [...pages].sort((a, b) => a - b)
  const contiguous = sorted.every((page, i) => i === 0 || page === sorted[i - 1]! + 1)
  return contiguous ? formatPageRange(sorted) : sorted.map((page) => page + 1).join(", ")
}

function PartsList({
  parts,
  onRemove,
  disabled,
}: {
  parts: SplitPart[]
  onRemove: (index: number) => void
  disabled: boolean
}) {
  if (parts.length === 0) {
    return (
      <p className="text-[14px] font-semibold text-muted-ink">
        No parts yet — select pages and add a part.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2.5">
      {parts.map((part, index) => (
        <div
          key={index}
          className="flex items-center gap-3 rounded-[14px] border-2 border-ink bg-surface px-3 py-2.5"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] border-2 border-ink bg-soft-amber font-heading text-[15px] font-extrabold text-ink">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-heading text-[14px] font-extrabold text-ink">Part {index + 1}</div>
            <div className="text-[13px] font-semibold text-muted-ink">
              {partLabel(part.pages)} · {part.pages.length} page{part.pages.length > 1 ? "s" : ""}
            </div>
          </div>
          <button
            type="button"
            aria-label={`Remove part ${index + 1}`}
            disabled={disabled}
            onClick={() => onRemove(index)}
            className="press flex size-8 shrink-0 items-center justify-center rounded-[9px] border-2 border-ink text-ink disabled:opacity-30"
          >
            <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={2.4} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** A pill-shaped "Back" chip for the mode/build steps — distinct from
ToolHeader's "All tools" link, which always returns to the homepage. */
function BackChip({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press mb-5 inline-flex items-center gap-2 rounded-full border-2 border-ink bg-card px-4 py-2 text-[13px] font-extrabold uppercase tracking-wide text-ink shadow-block-sm"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} className="size-3.5" strokeWidth={2.6} />
      Back
    </button>
  )
}

function SplitPage() {
  const {
    step,
    file,
    mode,
    pageCount,
    thumbnails,
    selection,
    parts,
    pagesPerFile,
    status,
    result,
    error,
    progress,
    downloadNames,
  } = useSplitStore()
  const inputRef = React.useRef<HTMLInputElement>(null)

  const loadFile = React.useCallback((incoming: FileList | File[] | null) => {
    const picked = incoming?.[0]
    if (!picked || !isPdfFile(picked)) return
    const run = ++renderRun.current
    useSplitStore.setState({
      file: picked,
      mode: null,
      pageCount: 0,
      thumbnails: [],
      selection: [],
      parts: [],
      pagesPerFile: 10,
      status: "idle",
      result: null,
      error: null,
      downloadNames: [],
      step: "upload",
    })
    renderThumbnails(
      picked,
      (count) => {
        if (renderRun.current !== run) return
        useSplitStore.setState({
          pageCount: count,
          thumbnails: Array.from({ length: count }, () => null),
        })
      },
      (index, dataUrl) => {
        if (renderRun.current !== run) return
        useSplitStore.setState((state) => {
          const next = [...state.thumbnails]
          next[index] = dataUrl
          return { thumbnails: next }
        })
      },
      () => renderRun.current !== run,
    )
      .then((count) => {
        if (renderRun.current !== run) return
        if (count > MAX_PAGES) {
          useSplitStore.setState({
            file: null,
            error: `This tool handles up to ${MAX_PAGES} pages — this file has ${count}.`,
          })
        }
      })
      .catch((err) => {
        if (renderRun.current !== run) return
        useSplitStore.setState({
          file: null,
          error:
            err?.name === "PasswordException"
              ? "This PDF is password-protected — unlock it first."
              : "Couldn't read this PDF.",
        })
      })
  }, [])

  // Adopt a file handed off from the landing page — only into an empty, idle
  // page, and only take() when adopting so an unclaimed file survives for a
  // different tool choice.
  React.useEffect(() => {
    const state = useSplitStore.getState()
    if (state.file !== null || state.status !== "idle") return
    const pending = useHandoffStore.getState().takeMatching(isPdfFile, 1)
    if (pending.length > 0) loadFile(pending)
    // Intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clearFile = () => {
    renderRun.current++
    useSplitStore.setState({ file: null, pageCount: 0, thumbnails: [], error: null })
  }

  // Gallery selection: click toggles a page, click-drag paints a contiguous
  // range. Tracked with refs (not state) so pointer moves don't re-render.
  const pressingRef = React.useRef(false)
  const draggedRef = React.useRef(false)
  const dragStartRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    const finishPress = () => {
      if (pressingRef.current && !draggedRef.current && dragStartRef.current !== null) {
        const index = dragStartRef.current
        useSplitStore.setState((state) => ({
          selection: state.selection.includes(index)
            ? state.selection.filter((page) => page !== index)
            : [...state.selection, index],
        }))
      }
      pressingRef.current = false
      draggedRef.current = false
      dragStartRef.current = null
    }
    window.addEventListener("pointerup", finishPress)
    return () => window.removeEventListener("pointerup", finishPress)
  }, [])

  const partPages = React.useMemo(() => parts.map((part) => part.pages), [parts])
  const assigned = React.useMemo(() => assignedPageSet(partPages), [partPages])
  const frontier = nextFrontier(partPages)

  const partIndexByPage = React.useMemo(() => {
    const map = new Map<number, number>()
    parts.forEach((part, partIndex) => {
      part.pages.forEach((page) => map.set(page, partIndex))
    })
    return map
  }, [parts])

  const isSelectable = (index: number): boolean => {
    if (mode === "extract") return !assigned.has(index)
    if (mode === "consecutive") return index >= frontier
    return true
  }

  const setRangeSelection = (a: number, b: number) => {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const range: number[] = []
    for (let i = lo; i <= hi; i++) {
      if (isSelectable(i)) range.push(i)
    }
    useSplitStore.setState({ selection: range })
  }

  const startPress = (index: number, event: React.PointerEvent<HTMLDivElement>) => {
    if (!isSelectable(index)) return
    // Release implicit pointer capture so pointerenter fires on other tiles during drag (touch).
    event.currentTarget.releasePointerCapture(event.pointerId)
    pressingRef.current = true
    draggedRef.current = false
    dragStartRef.current = index
  }

  const enterPress = (index: number) => {
    if (!pressingRef.current || dragStartRef.current === null) return
    draggedRef.current = true
    setRangeSelection(dragStartRef.current, index)
  }

  const sortedSelection = selectionToSortedPages(new Set(selection))
  const canAddPart =
    sortedSelection.length > 0 && (mode !== "consecutive" || isContiguousFrom(sortedSelection, frontier))

  const addPart = () => {
    if (!canAddPart) return
    useSplitStore.setState((state) => ({
      parts: [...state.parts, { pages: sortedSelection }],
      selection: [],
    }))
  }

  const removePart = (index: number) => {
    useSplitStore.setState((state) => ({
      // Consecutive parts share one running frontier, so removing part i
      // invalidates every part after it — drop them too.
      parts: state.mode === "consecutive" ? state.parts.slice(0, index) : state.parts.filter((_, i) => i !== index),
    }))
  }

  const everyNParts = React.useMemo(() => partsFromEveryN(pageCount, pagesPerFile), [pageCount, pagesPerFile])

  const canSubmit =
    mode === "extract"
      ? parts.length >= 1
      : mode === "consecutive"
        ? pageCount > 0 && assigned.size === pageCount
        : mode === "every-n"
          ? pagesPerFile >= 1 && pageCount >= 1
          : false

  const chooseMode = (nextMode: SplitMode) => {
    useSplitStore.setState({ mode: nextMode, step: "build", parts: [], selection: [], pagesPerFile: 10 })
  }

  const backToUpload = () => useSplitStore.setState({ step: "upload" })
  const backToMode = () => useSplitStore.setState({ step: "mode", parts: [], selection: [] })
  const continueToMode = () => useSplitStore.setState({ step: "mode" })

  const handleSplit = async () => {
    if (!file || !canSubmit) return
    useSplitStore.setState({
      status: "loading",
      error: null,
      result: null,
      progress: { phase: "uploading", percent: 0 },
    })
    try {
      // Read fresh via getState() so a job kicked off here keeps reporting
      // correctly even if the page unmounts before it resolves.
      const current = useSplitStore.getState()
      const submittedParts =
        current.mode === "every-n"
          ? partsFromEveryN(current.pageCount, current.pagesPerFile)
          : current.parts.map((part) => part.pages)
      const split = await splitPdf(current.file!, submittedParts, (p) =>
        useSplitStore.setState({ progress: p }),
      )
      useSplitStore.setState({
        result: split,
        status: "success",
        downloadNames: defaultPartFilenames(current.file!.name, submittedParts.length),
        step: "rename",
      })
    } catch (err) {
      useSplitStore.setState({
        error: err instanceof Error ? err.message : "Something went wrong.",
        status: "error",
      })
    } finally {
      useSplitStore.setState({ progress: null })
    }
  }

  // Page-range hints on the rename step: for every-N the parts were never
  // stored (computed on submit), so recompute them from the pageCount /
  // pagesPerFile that are still sitting in the store.
  const partPagesForHint = mode === "every-n" ? everyNParts : partPages

  const renameFile = (index: number, value: string) => {
    useSplitStore.setState((state) => {
      const next = [...state.downloadNames]
      next[index] = value
      return { downloadNames: next }
    })
  }

  const hasEmptyName = downloadNames.some((name) => name.trim().length === 0)
  const hasDuplicates = hasDuplicateFilenames(downloadNames.map(normalizePdfFilename))

  const handleDownload = async () => {
    if (!result || !file) return
    const names = downloadNames.map(normalizePdfFilename)
    if (names.length === 1) {
      downloadBlob(result.blob, names[0]!)
      return
    }
    try {
      const renamed = await renameZipEntries(result.blob, names)
      const stem = file.name.replace(/\.pdf$/i, "") || "document"
      downloadBlob(renamed, `${stem}-split.zip`)
    } catch (err) {
      useSplitStore.setState({
        error: err instanceof Error ? err.message : "Couldn't prepare download.",
      })
    }
  }

  const loading = status === "loading"

  return (
    <div className="pb-4">
      <ToolHeader
        icon={Files01Icon}
        title="Split PDF"
        subtitle="Break one PDF into smaller files, your way."
      />

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(event) => loadFile(event.target.files)}
      />

      {/* ── Step: upload ── */}
      {step === "upload" && (
        <div className="mx-auto mt-8 max-w-xl">
          {!file ? (
            <Dropzone
              onFiles={loadFile}
              onPick={() => inputRef.current?.click()}
              title="Drop a PDF here"
              hint="One file at a time"
            />
          ) : (
            <div className="rounded-[20px] border-2 border-ink bg-card p-[22px] shadow-block-lg">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-[13px] font-extrabold uppercase tracking-wide text-muted-ink">
                  {file.name} — {formatBytes(file.size)}
                </span>
                <button
                  type="button"
                  aria-label="Remove file"
                  onClick={clearFile}
                  className="press flex size-8 shrink-0 items-center justify-center rounded-[9px] border-2 border-ink text-ink"
                >
                  <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={2.4} />
                </button>
              </div>
              <p className="mt-3 text-[14px] font-semibold text-muted-ink">
                {pageCount > 0 ? `${pageCount} page${pageCount > 1 ? "s" : ""} found.` : "Reading pages…"}
              </p>
              <Button size="lg" className="mt-5 w-full" disabled={pageCount === 0} onClick={continueToMode}>
                Continue
              </Button>
            </div>
          )}
          {error && (
            <p className="mt-5 rounded-[12px] border-2 border-destructive bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">
              {error}
            </p>
          )}
        </div>
      )}

      {/* ── Step: mode ── */}
      {step === "mode" && (
        <div className="mt-8">
          <BackChip onClick={backToUpload} />
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
            {MODES.map((option) => (
              <ModeCard
                key={option.mode}
                icon={option.icon}
                title={option.title}
                description={option.description}
                onSelect={() => chooseMode(option.mode)}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Step: build ── */}
      {step === "build" && mode && (
        <div className="mt-8">
          <BackChip onClick={backToMode} />
          <div className="grid grid-cols-1 items-start gap-7 lg:grid-cols-[1fr_360px]">
            {/* Left: gallery or the every-N form */}
            <div className="rounded-[20px] border-2 border-ink bg-card p-[22px] shadow-block-lg">
              {mode === "every-n" ? (
                <div>
                  <label className="text-[13px] font-extrabold uppercase tracking-wide text-ink">
                    Pages per file
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={Math.max(1, pageCount)}
                    value={pagesPerFile}
                    onChange={(event) => {
                      const next = Number(event.target.value)
                      const clamped = Number.isFinite(next)
                        ? Math.min(Math.max(1, Math.round(next)), Math.max(1, pageCount))
                        : 1
                      useSplitStore.setState({ pagesPerFile: clamped })
                    }}
                    className="mt-2 w-full rounded-[12px] border-2 border-ink bg-surface px-4 py-3 text-base font-bold text-ink outline-none focus:shadow-block-sm"
                  />
                  <p className="mt-4 text-[14px] font-semibold text-muted-ink">
                    {pageCount} pages → {everyNParts.length} file{everyNParts.length !== 1 ? "s" : ""}
                    {everyNParts.length > 0 &&
                      ` (last file has ${everyNParts[everyNParts.length - 1]!.length} page${
                        everyNParts[everyNParts.length - 1]!.length !== 1 ? "s" : ""
                      })`}
                  </p>
                </div>
              ) : (
                <>
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] font-extrabold uppercase tracking-wide text-muted-ink">
                      {mode === "extract"
                        ? "Tap pages to select — unused pages are fine."
                        : frontier < pageCount
                          ? `Next part starts at page ${frontier + 1}.`
                          : "All pages assigned."}
                    </span>
                    {mode === "consecutive" && (
                      <span className="text-[13px] font-bold text-muted-ink">
                        {assigned.size} of {pageCount} pages assigned
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-4 gap-2.5 sm:grid-cols-6 md:grid-cols-8">
                    {thumbnails.map((thumbnail, index) => {
                      const partIndex = partIndexByPage.get(index)
                      return (
                        <PageThumb
                          key={index}
                          index={index}
                          thumbnail={thumbnail}
                          selected={selection.includes(index)}
                          disabled={!isSelectable(index)}
                          badge={partIndex !== undefined ? `P${partIndex + 1}` : undefined}
                          onPointerDown={(event) => startPress(index, event)}
                          onPointerEnter={() => enterPress(index)}
                        />
                      )
                    })}
                  </div>
                </>
              )}
            </div>

            {/* Right: parts list / summary + submit — sticky so it stays in view */}
            <div className="rounded-[20px] border-2 border-ink bg-card p-6 shadow-block-lg sm:p-8 lg:sticky lg:top-7">
              {mode === "every-n" ? (
                <p className="mb-5 text-[14px] font-semibold text-muted-ink">
                  Equal chunks, last one may be shorter. No page selection needed.
                </p>
              ) : (
                <>
                  <div className="mb-3.5 flex items-center justify-between">
                    <span className="text-[13px] font-extrabold uppercase tracking-wide text-ink">Parts</span>
                    <Button variant="outline" size="sm" onClick={addPart} disabled={!canAddPart}>
                      <HugeiconsIcon icon={PlusSignIcon} className="size-4" strokeWidth={2.6} />
                      Add part
                    </Button>
                  </div>
                  <PartsList parts={parts} onRemove={removePart} disabled={loading} />
                  <div className="my-5 h-[2.5px] rounded bg-ink" />
                </>
              )}

              <Button size="lg" onClick={handleSplit} disabled={!canSubmit || loading} className="w-full">
                {loading ? (
                  <>
                    <HugeiconsIcon icon={Loading03Icon} className="animate-spin" />
                    Splitting…
                  </>
                ) : (
                  "Split PDF"
                )}
              </Button>

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

              {status === "error" && error && (
                <p className="mt-5 rounded-[12px] border-2 border-destructive bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">
                  {error}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Step: rename (the success surface — no auto-download) ── */}
      {step === "rename" && result && (
        <div className="mx-auto mt-8 max-w-2xl">
          <motion.div
            className="rounded-[20px] border-2 border-ink bg-card p-[22px] shadow-block-lg"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
          >
            <div className="font-heading text-lg font-extrabold text-ink">Name your files</div>
            <p className="mt-1 text-[14px] font-semibold text-muted-ink">
              {downloadNames.length > 1 ? `${downloadNames.length} files ready.` : "1 file ready."} Edit the
              names, then download.
            </p>

            <div className="mt-5 flex flex-col gap-3">
              {downloadNames.map((name, index) => (
                <div key={index} className="flex items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] border-2 border-ink bg-soft-amber font-heading text-[14px] font-extrabold text-ink">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <input
                      value={name}
                      onChange={(event) => renameFile(index, event.target.value)}
                      className="w-full rounded-[10px] border-2 border-ink bg-surface px-3 py-2 text-[14px] font-bold text-ink outline-none focus:shadow-block-sm"
                    />
                    {partPagesForHint[index] && (
                      <div className="mt-1 text-[12px] font-semibold text-muted-ink">
                        {formatPageRange(partPagesForHint[index]!)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {(hasEmptyName || hasDuplicates) && (
              <p className="mt-4 text-[13px] font-bold text-destructive">
                {hasEmptyName ? "File names can't be empty." : "File names must be unique."}
              </p>
            )}

            {error && (
              <p className="mt-4 rounded-[12px] border-2 border-destructive bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">
                {error}
              </p>
            )}

            <div className="mt-6 flex items-center gap-3.5">
              <Button size="lg" className="flex-1" onClick={handleDownload} disabled={hasEmptyName || hasDuplicates}>
                <HugeiconsIcon icon={Download04Icon} strokeWidth={2.2} />
                Download
              </Button>
              <Button variant="outline" size="lg" onClick={() => useSplitStore.getState().reset()}>
                Split another
              </Button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  )
}
