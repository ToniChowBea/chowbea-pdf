import { createFileRoute } from "@tanstack/react-router"
import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { File01Icon, Loading03Icon } from "@hugeicons/core-free-icons"

import { ToolHeader } from "@/components/tool-header"
import { formatBytes } from "@/lib/api"
import { type QueueBoard, type QueueBoardEntry, fetchQueueBoard, recallJobIds } from "@/lib/jobs"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/queue")({ component: QueuePage })

const TOOL_LABELS: Record<string, string> = {
  compress: "Compress",
  lock: "Lock",
  unlock: "Unlock",
  merge: "Merge",
  rotate: "Rotate",
}

function BoardRow({
  entry,
  mine,
  position,
}: {
  entry: QueueBoardEntry
  mine: boolean
  position?: number
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-[14px] border-2 border-ink px-4 py-3",
        mine ? "bg-soft-amber" : "bg-surface",
      )}
    >
      {position !== undefined && (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] border-2 border-ink bg-card font-heading text-[15px] font-extrabold text-ink">
          {position}
        </span>
      )}
      <span className="font-mono text-[13px] font-bold text-muted-ink">#{entry.id_prefix}</span>
      <span className="font-heading text-[15px] font-extrabold text-ink">
        {TOOL_LABELS[entry.tool] ?? entry.tool}
      </span>
      <span className="text-[13px] font-semibold text-muted-ink">
        {entry.file_count} file{entry.file_count > 1 ? "s" : ""} · {formatBytes(entry.total_bytes)}
      </span>
      {mine && (
        <span className="ml-auto rounded-full bg-ink px-3 py-1 text-[12px] font-extrabold uppercase tracking-wide text-cream">
          Yours
        </span>
      )}
    </div>
  )
}

function QueuePage() {
  const [board, setBoard] = React.useState<QueueBoard | null>(null)
  const [error, setError] = React.useState(false)
  const myIds = React.useMemo(() => recallJobIds(), [])

  React.useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const next = await fetchQueueBoard()
        if (!cancelled) {
          setBoard(next)
          setError(false)
        }
      } catch {
        if (!cancelled) setError(true)
      }
    }
    load()
    const timer = setInterval(load, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const isMine = (entry: QueueBoardEntry) => myIds.some((id) => id.startsWith(entry.id_prefix))

  return (
    <div className="pb-4">
      <ToolHeader
        icon={File01Icon}
        title="Queue"
        subtitle="Live view of every job in line. Jobs run three at a time."
      />

      <div className="mt-8 flex flex-col gap-7">
        {error && (
          <p className="rounded-[12px] border-2 border-destructive bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">
            Couldn't reach the queue. Retrying…
          </p>
        )}

        {!board && !error && (
          <div className="flex items-center gap-2 text-[13px] font-extrabold uppercase tracking-wide text-muted-ink">
            <HugeiconsIcon icon={Loading03Icon} className="size-4 animate-spin" />
            Loading queue
          </div>
        )}

        {board && (
          <>
            <section className="rounded-[20px] border-2 border-ink bg-card p-[22px] shadow-block-lg">
              <div className="mb-4 text-[13px] font-extrabold uppercase tracking-wide text-ink">
                Processing now ({board.processing.length}/{board.concurrency})
              </div>
              {board.processing.length === 0 ? (
                <p className="text-[14px] font-semibold text-muted-ink">
                  Nothing processing — new jobs start instantly.
                </p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {board.processing.map((entry) => (
                    <BoardRow key={entry.id_prefix} entry={entry} mine={isMine(entry)} />
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-[20px] border-2 border-ink bg-card p-[22px] shadow-block-lg">
              <div className="mb-4 text-[13px] font-extrabold uppercase tracking-wide text-ink">
                Waiting ({board.waiting.length})
              </div>
              {board.waiting.length === 0 ? (
                <p className="text-[14px] font-semibold text-muted-ink">The line is empty.</p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {board.waiting.map((entry, index) => (
                    <BoardRow
                      key={entry.id_prefix}
                      entry={entry}
                      mine={isMine(entry)}
                      position={index + 1}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
