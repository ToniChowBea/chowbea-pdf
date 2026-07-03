import { HugeiconsIcon } from "@hugeicons/react"
import { SquareLock01Icon } from "@hugeicons/core-free-icons"

import { cn } from "@/lib/utils"

/** A little ink-outlined "page" with an amber title bar and line skeletons. */
function PageThumb({ dimmed }: { dimmed?: boolean }) {
  return (
    <div
      className={cn(
        "h-[152px] w-[120px] rounded-md border-2 border-ink bg-white p-3.5",
        dimmed && "opacity-70 blur-[1px]",
      )}
    >
      <div className="h-2 w-[46px] rounded bg-amber" />
      <div className="mt-3.5 h-1.5 w-full rounded bg-line" />
      <div className="mt-2 h-1.5 w-[90%] rounded bg-line" />
      <div className="mt-2 h-1.5 w-[96%] rounded bg-line" />
      <div className="mt-2 h-1.5 w-[70%] rounded bg-line" />
      <div className="mt-2 h-1.5 w-[84%] rounded bg-line" />
    </div>
  )
}

/**
 * The file card shown in the left column of a focused flow: a framed page
 * preview, the file name + meta, and a "Replace file" chip.
 */
export function FileCard({
  name,
  meta,
  onReplace,
  locked,
  disabled,
}: {
  name: string
  meta: string
  onReplace: () => void
  locked?: boolean
  disabled?: boolean
}) {
  return (
    <div className="rounded-[20px] border-2 border-ink bg-card p-[22px] shadow-block-lg">
      <div className="relative flex h-[200px] items-center justify-center overflow-hidden rounded-[14px] border-2 border-ink bg-cream">
        <PageThumb dimmed={locked} />
        {locked && (
          <span className="absolute flex size-12 items-center justify-center rounded-[13px] bg-ink text-amber">
            <HugeiconsIcon icon={SquareLock01Icon} className="size-6" strokeWidth={2.4} />
          </span>
        )}
      </div>
      <div className="mt-[18px] truncate font-heading text-lg font-extrabold text-ink">{name}</div>
      <div className="mt-1 text-sm font-semibold text-muted-ink">{meta}</div>
      <button
        type="button"
        onClick={onReplace}
        disabled={disabled}
        className="press mt-4 inline-block rounded-full border-2 border-ink px-4 py-1.5 text-[13px] font-extrabold uppercase tracking-wide text-ink disabled:opacity-30"
      >
        Replace file
      </button>
    </div>
  )
}
