import { createFileRoute } from "@tanstack/react-router"
import * as React from "react"
import { motion } from "motion/react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Download04Icon,
  Loading03Icon,
  SecurityCheckIcon,
  SquareUnlock02Icon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Dropzone } from "@/components/dropzone"
import { FileCard } from "@/components/file-card"
import { ToolHeader } from "@/components/tool-header"
import { useUnlockStore } from "@/stores/unlock"
import { useHandoffStore } from "@/stores/handoff"
import {
  type CompressionProgress,
  downloadBlob,
  formatBytes,
  unlockPdf,
} from "@/lib/api"

export const Route = createFileRoute("/unlock")({ component: UnlockPage })

const PHASE_LABELS: Record<CompressionProgress["phase"], string> = {
  uploading: "Uploading",
  queued: "In line",
  processing: "Unlocking",
  downloading: "Downloading",
}

function UnlockPage() {
  const { file, password, showPassword, status, result, error, progress } = useUnlockStore()
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Keep only the first PDF picked — unlock works on a single file at a time.
  const pickFile = React.useCallback((incoming: FileList | File[] | null) => {
    if (!incoming || incoming.length === 0) return
    const pdf = Array.from(incoming).find(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
    )
    if (!pdf) return
    useUnlockStore.setState({ file: pdf, status: "idle", result: null, error: null })
  }, [])

  // Adopt files handed off from the landing page — only into an empty, idle
  // page, and only take() when adopting so unclaimed files survive for a
  // different tool choice.
  React.useEffect(() => {
    const state = useUnlockStore.getState()
    if (state.file !== null || state.status !== "idle") return
    const pending = useHandoffStore.getState().take()
    if (pending.length > 0) pickFile(pending)
    // Intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleUnlock = async () => {
    if (!file || password.length === 0) return
    useUnlockStore.setState({
      status: "loading",
      error: null,
      result: null,
      progress: { phase: "uploading", percent: 0 },
    })
    try {
      const current = useUnlockStore.getState()
      if (!current.file) throw new Error("No file selected.")
      const unlocked = await unlockPdf(current.file, current.password, (p) =>
        useUnlockStore.setState({ progress: p }),
      )
      useUnlockStore.setState({ result: unlocked, status: "success" })
    } catch (err) {
      useUnlockStore.setState({
        error: err instanceof Error ? err.message : "Something went wrong.",
        status: "error",
      })
    } finally {
      useUnlockStore.setState({ progress: null })
    }
  }

  const canSubmit = Boolean(file) && password.length > 0 && status !== "loading"

  return (
    <div className="pb-4">
      <ToolHeader
        icon={SquareUnlock02Icon}
        title="Unlock PDF"
        subtitle="Remove the password so it opens without a prompt."
      />

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(event) => pickFile(event.target.files)}
      />

      <div className="mt-8 grid grid-cols-1 items-start gap-7 lg:grid-cols-[360px_1fr]">
        {/* ── Left: file ── */}
        {!file ? (
          <Dropzone
            onFiles={pickFile}
            onPick={() => inputRef.current?.click()}
            title="Drop a PDF here"
            hint="One file at a time"
          />
        ) : (
          <FileCard
            name={file.name}
            meta={`${formatBytes(file.size)} · Locked`}
            locked
            disabled={status === "loading"}
            onReplace={() => {
              useUnlockStore.setState({ file: null, status: "idle", result: null })
            }}
          />
        )}

        {/* ── Right: password ── */}
        <div className="rounded-[20px] border-2 border-ink bg-card p-6 shadow-block-lg sm:p-8">
          <h2 className="font-heading text-[22px] font-extrabold text-ink">This PDF is protected</h2>
          <p className="mt-1.5 max-w-[460px] text-[15px] font-semibold leading-relaxed text-subtext">
            Enter its current password and we&rsquo;ll save an unlocked copy. The original file stays
            untouched.
          </p>

          <div className="mt-6 mb-2 text-[13px] font-extrabold uppercase tracking-wide text-ink">
            Current password
          </div>
          <div className="flex max-w-[420px] items-center gap-2 rounded-[12px] border-2 border-ink bg-surface px-4 py-3 focus-within:shadow-block-sm">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => useUnlockStore.setState({ password: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSubmit) handleUnlock()
              }}
              placeholder="PDF password"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-base font-bold tracking-wide text-ink outline-none placeholder:font-semibold placeholder:tracking-normal placeholder:text-muted-ink"
            />
            <button
              type="button"
              aria-label={showPassword ? "Hide password" : "Show password"}
              onClick={() => useUnlockStore.setState((state) => ({ showPassword: !state.showPassword }))}
              className="flex shrink-0 items-center justify-center text-ink"
            >
              <HugeiconsIcon icon={showPassword ? ViewOffIcon : ViewIcon} className="size-5" strokeWidth={2.2} />
            </button>
          </div>

          <p className="mt-4 flex items-center gap-2 text-[13px] font-semibold text-[#7a6f5f]">
            <HugeiconsIcon icon={SecurityCheckIcon} className="size-4 text-amber" strokeWidth={2.2} />
            You must know the password — we never crack it, and never store it.
          </p>

          <Button
            size="lg"
            onClick={handleUnlock}
            disabled={!canSubmit}
            className="mt-7 w-full"
          >
            {status === "loading" ? (
              <>
                <HugeiconsIcon icon={Loading03Icon} className="animate-spin" />
                Unlocking…
              </>
            ) : (
              <>
                <HugeiconsIcon icon={SquareUnlock02Icon} strokeWidth={2.2} />
                Unlock PDF
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
              <div className="flex items-center justify-between">
                <span className="font-heading text-lg font-extrabold text-ink">Unlocked</span>
                <span className="rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-extrabold uppercase tracking-wide text-cream">
                  Done
                </span>
              </div>
              <p className="mt-2 text-sm font-semibold text-subtext">
                The password has been removed. Your file opens without a prompt now.
              </p>
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
