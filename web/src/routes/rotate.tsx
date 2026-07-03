import { createFileRoute } from "@tanstack/react-router"
import * as React from "react"
import { motion } from "motion/react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  Download04Icon,
  Loading03Icon,
  RotateClockwiseIcon,
} from "@hugeicons/core-free-icons"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Dropzone } from "@/components/dropzone"
import { ToolHeader } from "@/components/tool-header"
import { cn } from "@/lib/utils"
import { type PageCard, useRotateStore } from "@/stores/rotate"
import { useHandoffStore } from "@/stores/handoff"
import {
  type CompressionProgress,
  downloadBlob,
  formatBytes,
  rotatePdf,
} from "@/lib/api"

export const Route = createFileRoute("/rotate")({ component: RotatePage })

const MAX_PAGES = 300

const PHASE_LABELS: Record<CompressionProgress["phase"], string> = {
  uploading: "Uploading",
  queued: "In line",
  processing: "Rotating",
  downloading: "Downloading",
}

// Cancellation token for in-flight thumbnail rendering. Module scope: a
// remount must still be able to invalidate a previous file's render run.
const renderRun = { current: 0 }

/** Render every page to a small data-URL thumbnail, reporting one at a time.

`onCount` fires as soon as the page count is known (before any rendering), so
the grid can show placeholder cards while thumbnails stream in. */
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

function SortablePage({
  card,
  position,
  disabled,
  onRotate,
}: {
  card: PageCard
  position: number
  disabled: boolean
  onRotate: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: String(card.originalIndex), disabled })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex flex-col gap-2 rounded-[14px] border-2 border-ink bg-surface p-2.5",
        isDragging && "z-10 opacity-80 shadow-block-lg",
      )}
    >
      <div
        {...attributes}
        {...listeners}
        className="flex aspect-[3/4] cursor-grab items-center justify-center overflow-hidden rounded-[9px] border-2 border-ink bg-card active:cursor-grabbing"
      >
        {card.thumbnail ? (
          <img
            src={card.thumbnail}
            alt={`Page ${card.originalIndex + 1}`}
            style={{ transform: `rotate(${card.rotation}deg)` }}
            className="max-h-full max-w-full transition-transform"
            draggable={false}
          />
        ) : (
          <HugeiconsIcon icon={Loading03Icon} className="size-5 animate-spin text-muted-ink" />
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className="flex size-7 items-center justify-center rounded-[8px] border-2 border-ink bg-soft-amber font-heading text-[13px] font-extrabold text-ink">
          {card.originalIndex + 1}
        </span>
        <span className="text-[12px] font-bold text-muted-ink">
          {position}. {card.rotation ? `${card.rotation}°` : ""}
        </span>
        <button
          type="button"
          aria-label={`Rotate page ${card.originalIndex + 1}`}
          disabled={disabled}
          onClick={onRotate}
          className="press flex size-7 items-center justify-center rounded-[8px] border-2 border-ink text-ink disabled:opacity-30"
        >
          <HugeiconsIcon icon={RotateClockwiseIcon} className="size-4" strokeWidth={2.4} />
        </button>
      </div>
    </div>
  )
}

function RotatePage() {
  const { file, cards, status, result, error, progress } = useRotateStore()
  const inputRef = React.useRef<HTMLInputElement>(null)

  const loadFile = React.useCallback((incoming: FileList | File[] | null) => {
    const picked = incoming?.[0]
    if (!picked) return
    const isPdf =
      picked.type === "application/pdf" || picked.name.toLowerCase().endsWith(".pdf")
    if (!isPdf) return
    const run = ++renderRun.current
    useRotateStore.setState({ file: picked, cards: [], status: "idle", result: null, error: null })
    renderThumbnails(
      picked,
      (pageCount) => {
        if (renderRun.current !== run) return
        // Seed placeholder cards immediately; thumbnails stream in below.
        useRotateStore.setState({
          cards: Array.from({ length: pageCount }, (_, i) => ({
            originalIndex: i,
            rotation: 0,
            thumbnail: null,
          })),
        })
      },
      (index, dataUrl) => {
        if (renderRun.current !== run) return
        useRotateStore.setState((state) => ({
          cards: state.cards.map((card) =>
            card.originalIndex === index ? { ...card, thumbnail: dataUrl } : card,
          ),
        }))
      },
      () => renderRun.current !== run,
    )
      .then((pageCount) => {
        if (renderRun.current !== run) return
        if (pageCount > MAX_PAGES) {
          useRotateStore.setState({
            file: null,
            error: `This tool handles up to ${MAX_PAGES} pages — this file has ${pageCount}.`,
          })
        }
      })
      .catch((err) => {
        if (renderRun.current !== run) return
        useRotateStore.setState({
          file: null,
          error:
            err?.name === "PasswordException"
              ? "This PDF is password-protected — unlock it first."
              : "Couldn't read this PDF.",
        })
      })
  }, [])

  // Adopt files handed off from the landing page — only into an empty, idle
  // page, and only take() when adopting so unclaimed files survive for a
  // different tool choice.
  React.useEffect(() => {
    const state = useRotateStore.getState()
    if (state.file !== null || state.cards.length > 0 || state.status !== "idle") return
    const pending = useHandoffStore.getState().take()
    if (pending.length > 0) loadFile(pending)
    // Intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    useRotateStore.setState((state) => {
      const from = state.cards.findIndex((c) => String(c.originalIndex) === active.id)
      const to = state.cards.findIndex((c) => String(c.originalIndex) === over.id)
      if (from < 0 || to < 0) return state
      return { cards: arrayMove(state.cards, from, to) }
    })
  }

  const rotateCard = (originalIndex: number) => {
    useRotateStore.setState((state) => ({
      cards: state.cards.map((card) =>
        card.originalIndex === originalIndex
          ? { ...card, rotation: (card.rotation + 90) % 360 }
          : card,
      ),
    }))
  }

  const rotateAll = () => {
    useRotateStore.setState((state) => ({
      cards: state.cards.map((card) => ({ ...card, rotation: (card.rotation + 90) % 360 })),
    }))
  }

  const reset = () => {
    useRotateStore.setState((state) => ({
      cards: [...state.cards]
        .sort((a, b) => a.originalIndex - b.originalIndex)
        .map((card) => ({ ...card, rotation: 0 })),
      status: "idle" as const,
      result: null,
      error: null,
    }))
  }

  const clearFile = () => {
    renderRun.current++
    useRotateStore.setState({ file: null, cards: [], status: "idle", result: null, error: null })
  }

  const changed = cards.some((card, i) => card.rotation !== 0 || card.originalIndex !== i)
  const loading = status === "loading"

  const handleSubmit = async () => {
    if (!file || !changed) return
    useRotateStore.setState({
      status: "loading",
      error: null,
      result: null,
      progress: { phase: "uploading", percent: 0 },
    })
    try {
      // Read fresh via getState() so a job kicked off here keeps reporting
      // correctly even if the page unmounts before it resolves.
      const current = useRotateStore.getState()
      const rotated = await rotatePdf(
        current.file!,
        current.cards.map((card) => ({ index: card.originalIndex, rotation: card.rotation })),
        (p) => useRotateStore.setState({ progress: p }),
      )
      useRotateStore.setState({ result: rotated, status: "success" })
    } catch (err) {
      useRotateStore.setState({
        error: err instanceof Error ? err.message : "Something went wrong.",
        status: "error",
      })
    } finally {
      useRotateStore.setState({ progress: null })
    }
  }

  return (
    <div className="pb-4">
      <ToolHeader
        icon={RotateClockwiseIcon}
        title="Rotate PDF"
        subtitle="Tap to rotate pages, drag to reorder them."
      />

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(event) => loadFile(event.target.files)}
      />

      <div className="mt-8 grid grid-cols-1 items-start gap-7 lg:grid-cols-[1fr_320px]">
        {/* ── Left: page grid ── */}
        {!file ? (
          <Dropzone
            onFiles={loadFile}
            onPick={() => inputRef.current?.click()}
            title="Drop a PDF here"
            hint="One file at a time"
          />
        ) : (
          <div className="rounded-[20px] border-2 border-ink bg-card p-[22px] shadow-block-lg">
            <div className="mb-4 flex items-center justify-between">
              <span className="truncate text-[13px] font-extrabold uppercase tracking-wide text-muted-ink">
                {file.name} — {formatBytes(file.size)}
              </span>
              <button
                type="button"
                aria-label="Remove file"
                disabled={loading}
                onClick={clearFile}
                className="press flex size-8 shrink-0 items-center justify-center rounded-[9px] border-2 border-ink text-ink disabled:opacity-30"
              >
                <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={2.4} />
              </button>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext
                items={cards.map((c) => String(c.originalIndex))}
                strategy={rectSortingStrategy}
              >
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {cards.map((card, i) => (
                    <SortablePage
                      key={card.originalIndex}
                      card={card}
                      position={i + 1}
                      disabled={loading}
                      onRotate={() => rotateCard(card.originalIndex)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        )}

        {/* ── Right: actions — sticky on desktop so it stays in view beside long grids ── */}
        <div className="rounded-[20px] border-2 border-ink bg-card p-6 shadow-block-lg sm:p-8 lg:sticky lg:top-7">
          <div className="mb-3.5 text-[13px] font-extrabold uppercase tracking-wide text-ink">
            Rotate & reorder
          </div>
          <p className="text-[14px] font-semibold text-muted-ink">
            The grid order becomes the page order. Rotations preview instantly and
            are applied losslessly.
          </p>

          <div className="mt-5 flex flex-col gap-2.5">
            <Button variant="outline" onClick={rotateAll} disabled={!file || loading}>
              Rotate all 90°
            </Button>
            <Button variant="outline" onClick={reset} disabled={!file || loading || !changed}>
              Reset
            </Button>
          </div>

          <Button
            size="lg"
            onClick={handleSubmit}
            disabled={!file || !changed || loading}
            className="mt-6 w-full"
          >
            {loading ? (
              <>
                <HugeiconsIcon icon={Loading03Icon} className="animate-spin" />
                Rotating…
              </>
            ) : (
              "Rotate PDF"
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

          {/* Error (job failures and load-time rejections alike) */}
          {error && (status === "error" || status === "idle") && (
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
                Pages rearranged
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
