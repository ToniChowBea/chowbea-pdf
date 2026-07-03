import { createFileRoute } from "@tanstack/react-router"
import * as React from "react"
import { motion } from "motion/react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Download04Icon,
  Loading03Icon,
  SquareLock01Icon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ToggleSwitch } from "@/components/ui/toggle-switch"
import { Dropzone } from "@/components/dropzone"
import { FileCard } from "@/components/file-card"
import { ToolHeader } from "@/components/tool-header"
import { isPdfFile } from "@/lib/supported-files"
import { cn } from "@/lib/utils"
import { useLockStore } from "@/stores/lock"
import { useHandoffStore } from "@/stores/handoff"
import {
  type CompressionProgress,
  type EncryptionLevel,
  downloadBlob,
  formatBytes,
  lockPdf,
} from "@/lib/api"

export const Route = createFileRoute("/lock")({ component: LockPage })

const PHASE_LABELS: Record<CompressionProgress["phase"], string> = {
  uploading: "Uploading",
  queued: "In line",
  processing: "Locking",
  downloading: "Downloading",
}

// A rough 0–4 strength score from length and character variety.
const STRENGTH_LABELS = ["", "Weak", "Fair", "Good", "Strong"] as const

function passwordStrength(pw: string): { score: number; label: string } {
  if (!pw) return { score: 0, label: "" }
  let score = 0
  if (pw.length >= 8) score++
  if (pw.length >= 12) score++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++
  if (/\d/.test(pw)) score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  score = Math.min(4, score)
  return { score, label: STRENGTH_LABELS[score] }
}

/** An ink-outlined password field with a show/hide eye. */
function PasswordInput({
  value,
  onChange,
  reveal,
  onToggleReveal,
  placeholder,
  onEnter,
}: {
  value: string
  onChange: (next: string) => void
  reveal: boolean
  onToggleReveal: () => void
  placeholder: string
  onEnter?: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-[12px] border-2 border-ink bg-surface px-4 py-3 focus-within:shadow-block-sm">
      <input
        type={reveal ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onEnter?.()
        }}
        placeholder={placeholder}
        autoComplete="new-password"
        className="min-w-0 flex-1 bg-transparent text-base font-bold tracking-wide text-ink outline-none placeholder:font-semibold placeholder:tracking-normal placeholder:text-muted-ink"
      />
      <button
        type="button"
        aria-label={reveal ? "Hide password" : "Show password"}
        onClick={onToggleReveal}
        className="flex shrink-0 items-center justify-center text-ink"
      >
        <HugeiconsIcon icon={reveal ? ViewOffIcon : ViewIcon} className="size-5" strokeWidth={2.2} />
      </button>
    </div>
  )
}

const PERMISSIONS = [
  { key: "allowPrinting", label: "Allow printing" },
  { key: "allowCopying", label: "Allow copying text" },
  { key: "allowEditing", label: "Allow editing & annotations" },
] as const

const ENCRYPTION_CHOICES: Array<{ value: EncryptionLevel; label: string }> = [
  { value: "aes-256", label: "256-bit AES" },
  { value: "aes-128", label: "128-bit AES" },
]

function LockPage() {
  const {
    file,
    password,
    confirm,
    showNew,
    showConfirm,
    permissions,
    encryption,
    status,
    result,
    error,
    progress,
  } = useLockStore()
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Keep only the first PDF picked — lock works on a single file at a time.
  const pickFile = React.useCallback((incoming: FileList | File[] | null) => {
    if (!incoming || incoming.length === 0) return
    const pdf = Array.from(incoming).find(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
    )
    if (!pdf) return
    useLockStore.setState({ file: pdf, status: "idle", result: null, error: null })
  }, [])

  // Adopt files handed off from the landing page — only into an empty, idle
  // page, and only take() when adopting so unclaimed files survive for a
  // different tool choice.
  React.useEffect(() => {
    const state = useLockStore.getState()
    if (state.file !== null || state.status !== "idle") return
    const pending = useHandoffStore.getState().takeMatching(isPdfFile, 1)
    if (pending.length > 0) pickFile(pending)
    // Intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const strength = passwordStrength(password)
  const mismatch = confirm.length > 0 && confirm !== password
  const canSubmit =
    Boolean(file) && password.length > 0 && password === confirm && status !== "loading"

  const handleLock = async () => {
    if (!canSubmit || !file) return
    useLockStore.setState({
      status: "loading",
      error: null,
      result: null,
      progress: { phase: "uploading", percent: 0 },
    })
    try {
      const current = useLockStore.getState()
      if (!current.file) throw new Error("No file selected.")
      const locked = await lockPdf(
        current.file,
        { password: current.password, encryption: current.encryption, ...current.permissions },
        (p) => useLockStore.setState({ progress: p }),
      )
      useLockStore.setState({ result: locked, status: "success" })
    } catch (err) {
      useLockStore.setState({
        error: err instanceof Error ? err.message : "Something went wrong.",
        status: "error",
      })
    } finally {
      useLockStore.setState({ progress: null })
    }
  }

  const reset = () => {
    useLockStore.setState({
      file: null,
      password: "",
      confirm: "",
      status: "idle",
      result: null,
      error: null,
    })
  }

  return (
    <div className="pb-4">
      <ToolHeader
        icon={SquareLock01Icon}
        title="Lock PDF"
        subtitle="Add a password so only the right people can open it."
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
            meta={formatBytes(file.size)}
            onReplace={reset}
            disabled={status === "loading"}
          />
        )}

        {/* ── Right: settings ── */}
        <div className="rounded-[20px] border-2 border-ink bg-card p-6 shadow-block-lg sm:p-8">
          {/* Passwords */}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div>
              <div className="mb-2 text-[13px] font-extrabold uppercase tracking-wide text-ink">
                New password
              </div>
              <PasswordInput
                value={password}
                onChange={(value) => useLockStore.setState({ password: value })}
                reveal={showNew}
                onToggleReveal={() => useLockStore.setState((state) => ({ showNew: !state.showNew }))}
                placeholder="Choose a password"
                onEnter={handleLock}
              />
            </div>
            <div>
              <div className="mb-2 text-[13px] font-extrabold uppercase tracking-wide text-ink">
                Confirm password
              </div>
              <PasswordInput
                value={confirm}
                onChange={(value) => useLockStore.setState({ confirm: value })}
                reveal={showConfirm}
                onToggleReveal={() =>
                  useLockStore.setState((state) => ({ showConfirm: !state.showConfirm }))
                }
                placeholder="Repeat it"
                onEnter={handleLock}
              />
            </div>
          </div>

          {/* Strength + mismatch */}
          <div className="mt-3.5 flex items-center gap-3">
            <div className="flex flex-1 gap-1.5">
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className={cn(
                    "h-2 flex-1 rounded border-2 border-ink",
                    i < strength.score ? "bg-amber" : "bg-card",
                  )}
                />
              ))}
            </div>
            {strength.label && (
              <span className="text-[13px] font-extrabold uppercase tracking-wide text-ink">
                {strength.label}
              </span>
            )}
          </div>
          {mismatch && (
            <p className="mt-2 text-[13px] font-bold text-destructive">Passwords don&rsquo;t match.</p>
          )}

          <div className="my-6 h-[2.5px] rounded bg-ink" />

          {/* Permissions */}
          <div className="mb-4 font-heading text-base font-extrabold text-ink">Permissions</div>
          <div className="flex flex-col gap-3.5">
            {PERMISSIONS.map((perm) => (
              <div key={perm.key} className="flex items-center justify-between">
                <span className="text-[15px] font-semibold text-ink">{perm.label}</span>
                <ToggleSwitch
                  label={perm.label}
                  checked={permissions[perm.key]}
                  onChange={(next) =>
                    useLockStore.setState((state) => ({
                      permissions: { ...state.permissions, [perm.key]: next },
                    }))
                  }
                />
              </div>
            ))}
          </div>

          {/* Encryption */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <span className="text-[15px] font-semibold text-ink">Encryption</span>
            <div className="flex w-fit overflow-hidden rounded-[12px] border-2 border-ink shadow-block-sm">
              {ENCRYPTION_CHOICES.map((choice, i) => (
                <button
                  key={choice.value}
                  type="button"
                  onClick={() => useLockStore.setState({ encryption: choice.value })}
                  className={cn(
                    "px-4 py-2.5 text-[13px] font-extrabold uppercase tracking-wide transition-colors",
                    i > 0 && "border-l-2 border-ink",
                    encryption === choice.value ? "bg-ink text-cream" : "bg-card text-ink",
                  )}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>

          {/* CTA */}
          <div className="mt-7 flex items-center gap-3.5">
            <Button size="lg" onClick={handleLock} disabled={!canSubmit} className="flex-1">
              {status === "loading" ? (
                <>
                  <HugeiconsIcon icon={Loading03Icon} className="animate-spin" />
                  Locking…
                </>
              ) : (
                <>
                  <HugeiconsIcon icon={SquareLock01Icon} strokeWidth={2.2} />
                  Lock PDF
                </>
              )}
            </Button>
            <Button variant="outline" size="lg" onClick={reset} disabled={status === "loading"}>
              Cancel
            </Button>
          </div>

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
                <span className="font-heading text-lg font-extrabold text-ink">Locked</span>
                <span className="rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-extrabold uppercase tracking-wide text-cream">
                  {encryption === "aes-256" ? "256-bit AES" : "128-bit AES"}
                </span>
              </div>
              <p className="mt-2 text-sm font-semibold text-subtext">
                Your PDF now asks for this password before it opens. Keep it somewhere safe — we
                can&rsquo;t recover it.
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
