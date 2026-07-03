import { createFileRoute, Link } from "@tanstack/react-router"
import { motion } from "motion/react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDataTransferHorizontalIcon,
  ArrowRight02Icon,
  FileScanIcon,
  Files01Icon,
  Layers01Icon,
  Minimize01Icon,
  RotateClockwiseIcon,
  SquareLock01Icon,
  SquareUnlock02Icon,
  Upload04Icon,
} from "@hugeicons/core-free-icons"
import type { IconSvgElement } from "@hugeicons/react"

import { CoffeeBlock } from "@/components/coffee-block"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/")({ component: Home })

// A crisp ease-out-quart for the tile entrance.
const EASE_OUT_QUART = [0.22, 1, 0.36, 1] as [number, number, number, number]

type Tool = {
  name: string
  description: string
  icon: IconSvgElement
  to?: string
}

// The eight things you actually do to a PDF. Only the two with a `to` are live.
const TOOLS: Tool[] = [
  { name: "Unlock", description: "Remove a password", icon: SquareUnlock02Icon, to: "/unlock" },
  { name: "Lock", description: "Add a password", icon: SquareLock01Icon, to: "/lock" },
  { name: "Compress", description: "Shrink file size", icon: Minimize01Icon, to: "/compress" },
  { name: "OCR", description: "Make text searchable", icon: FileScanIcon },
  { name: "Merge", description: "Combine PDFs", icon: Layers01Icon, to: "/merge" },
  { name: "Split", description: "Separate pages", icon: Files01Icon },
  { name: "Convert", description: "To & from Word, images", icon: ArrowDataTransferHorizontalIcon },
  { name: "Rotate", description: "Rotate & reorder pages", icon: RotateClockwiseIcon, to: "/rotate" },
]

function ToolTile({ tool, index }: { tool: Tool; index: number }) {
  const live = Boolean(tool.to)

  const inner = (
    <motion.div
      className="flex h-full flex-col gap-4"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1 + index * 0.05, ease: EASE_OUT_QUART }}
    >
      <div className="flex items-start justify-between">
        <span
          className={cn(
            "flex size-[52px] items-center justify-center rounded-[13px] border-2 border-ink text-ink",
            live ? "bg-surface" : "bg-soft-amber",
          )}
        >
          <HugeiconsIcon icon={tool.icon} className="size-[26px]" strokeWidth={2.2} />
        </span>
        {live ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-ink px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.15em] text-cream">
            <span className="size-1.5 rounded-full bg-amber" />
            Live
          </span>
        ) : (
          <span className="rounded-full border-2 border-ink/30 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.15em] text-muted-ink">
            Soon
          </span>
        )}
      </div>

      <div className="mt-auto">
        <div className="flex items-center gap-2">
          <h3 className="font-heading text-[22px] font-extrabold text-ink">{tool.name}</h3>
          {live && (
            <HugeiconsIcon
              icon={ArrowRight02Icon}
              className="size-5 -translate-x-1.5 text-ink opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100"
              strokeWidth={2.4}
            />
          )}
        </div>
        <p
          className={cn(
            "mt-1 text-sm font-semibold",
            live ? "text-[#5a4324]" : "text-muted-ink",
          )}
        >
          {tool.description}
        </p>
      </div>
    </motion.div>
  )

  const base =
    "group flex flex-col rounded-[18px] border-2 border-ink p-6 shadow-block transition-[transform,box-shadow]"

  return tool.to ? (
    <Link
      to={tool.to}
      className={cn(
        base,
        "bg-amber hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-block-lg active:translate-x-[5px] active:translate-y-[5px] active:shadow-none",
      )}
    >
      {inner}
    </Link>
  ) : (
    <div className={cn(base, "cursor-default bg-card")}>{inner}</div>
  )
}

function Home() {
  return (
    <div className="pt-10 sm:pt-12">
      {/* ── Hero ── */}
      <div className="flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-center">
        <h1 className="font-heading text-[44px] font-extrabold uppercase leading-[0.98] tracking-tight text-ink sm:text-[58px] lg:text-[62px]">
          Pick a tool.
          <br />
          <span className="text-amber" style={{ WebkitTextStroke: "2px #211A12" }}>
            Drop a PDF.
          </span>
        </h1>

        <div className="flex max-w-[330px] flex-col items-start gap-4">
          <p className="text-[17px] font-semibold leading-snug text-subtext">
            No accounts, no clutter — just the eight things you actually do to a PDF.
          </p>
          <Link
            to="/compress"
            className="press inline-flex items-center gap-2.5 rounded-full border-2 border-ink bg-ink px-7 py-3.5 font-heading text-base font-extrabold uppercase tracking-wide text-cream shadow-amber-sm active:translate-x-[4px] active:translate-y-[4px] active:shadow-none"
          >
            <HugeiconsIcon icon={Upload04Icon} className="size-5" strokeWidth={2.2} />
            Upload PDF
          </Link>
        </div>
      </div>

      {/* ── Tool grid ── */}
      <div className="mt-11 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {TOOLS.map((tool, index) => (
          <ToolTile key={tool.name} tool={tool} index={index} />
        ))}
      </div>

      {/* ── Support ── */}
      <CoffeeBlock />
    </div>
  )
}
