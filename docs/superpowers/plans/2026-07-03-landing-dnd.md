# Landing Drag-and-Drop + Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The landing page accepts drag-and-drop/upload of files, previews the pending count, and hands the files into whichever tool the user then opens; copy shuffled; "Live" badges become "Active".

**Architecture:** A `useHandoffStore` (zustand) holds pending files with one-shot `take()` semantics; the landing page fills it (whole-page drop target + Upload button); each tool page adopts pending files on mount through its own existing intake function, only when empty and idle (check-before-take, so unadopted files survive for another tool choice).

**Tech Stack:** React, zustand, vitest. Web-only; no api changes, no new deps.

**Spec:** `docs/superpowers/specs/2026-07-03-landing-dnd-design.md`
**Branch:** `landing-dnd` (already created; `main` is protected).

## Global Constraints

- Hero copy exactly: `Click Upload PDF or drag and drop files anywhere to get started.` — preview variant `N file(s) ready — pick a tool below.`
- Sales line moves verbatim below `<CoffeeBlock />`: `No accounts, no clutter — just the eight things you actually do to a PDF.`
- Tile badge `Live` → `Active`; `Soon` untouched.
- Supported extensions exactly: `pdf png jpg jpeg docx md markdown html htm txt`.
- Handoff is one-shot (`take()` empties) and check-before-take: a page only takes when `files/file` empty AND `status === "idle"` (rotate also requires `cards.length === 0`); otherwise the pending files remain.
- Intake signatures widen to `FileList | File[] | null`; behavior otherwise unchanged.
- NO dev servers, NO browsers. Gates: `cd web && bun run test && bun run typecheck && bun run build`.
- Never `git add -A`.

---

### Task 1: Handoff store + supported-files helper

**Files:**
- Create: `web/src/stores/handoff.ts`, `web/src/lib/supported-files.ts`
- Test: `web/src/stores/handoff.test.ts`

**Interfaces:**
- Produces: `useHandoffStore` with `files: File[]` and `take(): File[]`; `SUPPORTED_ACCEPT: string`; `isSupportedFile(file: File): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/stores/handoff.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest"

import { isSupportedFile } from "@/lib/supported-files"
import { useHandoffStore } from "./handoff"

describe("handoff store", () => {
  beforeEach(() => useHandoffStore.setState({ files: [] }))

  it("take returns the pending files and empties the store", () => {
    const files = [new File(["a"], "a.pdf"), new File(["b"], "b.pdf")]
    useHandoffStore.setState({ files })
    expect(useHandoffStore.getState().take()).toEqual(files)
    expect(useHandoffStore.getState().files).toEqual([])
  })

  it("take on an empty store returns an empty array", () => {
    expect(useHandoffStore.getState().take()).toEqual([])
  })
})

describe("isSupportedFile", () => {
  it.each([
    ["doc.pdf", true],
    ["scan.PNG", true],
    ["photo.jpeg", true],
    ["notes.markdown", true],
    ["page.htm", true],
    ["report.docx", true],
    ["archive.zip", false],
    ["video.mp4", false],
    ["noextension", false],
  ])("%s -> %s", (name, expected) => {
    expect(isSupportedFile(new File(["x"], name))).toBe(expected)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && bun run test`
Expected: FAIL — cannot resolve `./handoff` / `@/lib/supported-files`.

- [ ] **Step 3: Implement**

`web/src/stores/handoff.ts`:
```ts
import { create } from "zustand"

interface HandoffState {
  /** Files picked on the landing page, waiting for the user to choose a tool. */
  files: File[]
  /** One-shot handoff: return the pending files and empty the store. */
  take: () => File[]
}

/** Module-level store: survives navigation from the landing page to a tool. */
export const useHandoffStore = create<HandoffState>()((set, get) => ({
  files: [],
  take: () => {
    const files = get().files
    if (files.length > 0) {
      set({ files: [] })
    }
    return files
  },
}))
```

`web/src/lib/supported-files.ts`:
```ts
/** Extensions any tool on the site can consume (Convert takes the exotic ones). */
const SUPPORTED_EXTENSIONS = [
  "pdf", "png", "jpg", "jpeg", "docx", "md", "markdown", "html", "htm", "txt",
]

/** `accept` attribute value for pickers that feed the tool handoff. */
export const SUPPORTED_ACCEPT = SUPPORTED_EXTENSIONS.map((ext) => `.${ext}`).join(",")

export function isSupportedFile(file: File): boolean {
  const ext = file.name.toLowerCase().split(".").pop() ?? ""
  return SUPPORTED_EXTENSIONS.includes(ext)
}
```

- [ ] **Step 4: Run to verify green**

Run: `cd web && bun run test`
Expected: PASS (23 total: 12 existing + 11 new).

- [ ] **Step 5: Commit**

```bash
git add web/src/stores/handoff.ts web/src/lib/supported-files.ts web/src/stores/handoff.test.ts
git commit -m "Add file handoff store and supported-files helper"
```

---

### Task 2: Landing page overhaul

**Files:**
- Modify: `web/src/routes/index.tsx`

**Interfaces:**
- Consumes: `useHandoffStore`, `SUPPORTED_ACCEPT`, `isSupportedFile` from Task 1; `formatBytes` from `@/lib/api`.

- [ ] **Step 1: Rework `index.tsx`**

Read the file first. Changes, precisely:

1. **Imports:** add back `import * as React from "react"`; add `Cancel01Icon` to the hugeicons import (Files01Icon and Upload04Icon are already imported); add:
```tsx
import { formatBytes } from "@/lib/api"
import { SUPPORTED_ACCEPT, isSupportedFile } from "@/lib/supported-files"
import { useHandoffStore } from "@/stores/handoff"
```
2. **Badge:** in `ToolTile`, the live-badge text `Live` becomes `Active` (the `Soon` badge is untouched).
3. **Home component** gains pending-files state, the intake callback, and whole-page drop handling. The component's top becomes:
```tsx
function Home() {
  const pending = useHandoffStore((state) => state.files)
  const [dragDepth, setDragDepth] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const addFiles = React.useCallback((incoming: FileList | File[] | null) => {
    if (!incoming) return
    const supported = Array.from(incoming).filter(isSupportedFile)
    if (supported.length === 0) return
    useHandoffStore.setState((state) => {
      const seen = new Set(state.files.map((f) => `${f.name}:${f.size}`))
      const unique: File[] = []
      for (const file of supported) {
        const key = `${file.name}:${file.size}`
        if (seen.has(key)) continue
        seen.add(key)
        unique.push(file)
      }
      return { files: [...state.files, ...unique] }
    })
  }, [])

  const hasFileDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes("Files")

  const totalSize = pending.reduce((sum, file) => sum + file.size, 0)
```
4. The root `<div className="pt-10 sm:pt-12">` becomes a **drop target with an overlay**:
```tsx
  return (
    <div
      className="relative pt-10 sm:pt-12"
      onDragEnter={(event) => {
        if (!hasFileDrag(event)) return
        event.preventDefault()
        setDragDepth((depth) => depth + 1)
      }}
      onDragOver={(event) => {
        if (hasFileDrag(event)) event.preventDefault()
      }}
      onDragLeave={(event) => {
        if (!hasFileDrag(event)) return
        setDragDepth((depth) => Math.max(0, depth - 1))
      }}
      onDrop={(event) => {
        if (!hasFileDrag(event)) return
        event.preventDefault()
        setDragDepth(0)
        addFiles(event.dataTransfer.files)
      }}
    >
      {dragDepth > 0 && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[24px] border-4 border-dashed border-ink bg-cream/90">
          <span className="font-heading text-2xl font-extrabold uppercase tracking-tight text-ink">
            Drop files anywhere
          </span>
        </div>
      )}
```
5. **Hero right column** — the paragraph + button block becomes:
```tsx
        <div className="flex max-w-[330px] flex-col items-start gap-4">
          <p className="text-[17px] font-semibold leading-snug text-subtext">
            {pending.length > 0
              ? `${pending.length} file${pending.length > 1 ? "s" : ""} ready — pick a tool below.`
              : "Click Upload PDF or drag and drop files anywhere to get started."}
          </p>
          {pending.length === 0 ? (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="press inline-flex items-center gap-2.5 rounded-full border-2 border-ink bg-ink px-7 py-3.5 font-heading text-base font-extrabold uppercase tracking-wide text-cream shadow-amber-sm active:translate-x-[4px] active:translate-y-[4px] active:shadow-none"
            >
              <HugeiconsIcon icon={Upload04Icon} className="size-5" strokeWidth={2.2} />
              Upload PDF
            </button>
          ) : (
            <div className="flex items-center gap-3 rounded-[16px] border-2 border-ink bg-card px-4 py-3 shadow-block-sm">
              <span className="flex size-11 items-center justify-center rounded-[10px] border-2 border-ink bg-soft-amber text-ink">
                <HugeiconsIcon icon={Files01Icon} className="size-5" strokeWidth={2.2} />
              </span>
              <div>
                <div className="font-heading text-[15px] font-extrabold text-ink">
                  {pending.length} file{pending.length > 1 ? "s" : ""} ready
                </div>
                <div className="text-[13px] font-semibold text-muted-ink">{formatBytes(totalSize)}</div>
              </div>
              <button
                type="button"
                aria-label="Clear selected files"
                onClick={() => useHandoffStore.setState({ files: [] })}
                className="press ml-1 flex size-8 items-center justify-center rounded-[9px] border-2 border-ink text-ink"
              >
                <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={2.4} />
              </button>
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={SUPPORTED_ACCEPT}
            className="hidden"
            onChange={(event) => addFiles(event.target.files)}
          />
        </div>
```
(The old `Link to="/compress"` Upload button is replaced by this button; keep the exact className.)
6. **Sales line** after `<CoffeeBlock />`:
```tsx
      <CoffeeBlock />
      <p className="mt-6 text-center text-[15px] font-semibold text-muted-ink">
        No accounts, no clutter — just the eight things you actually do to a PDF.
      </p>
```
(If the hero previously rendered this line, it is now gone from the hero.)

- [ ] **Step 2: Gates**

Run: `cd web && bun run test && bun run typecheck && bun run build`
Expected: 23 vitest passed, clean, green.

- [ ] **Step 3: Commit**

```bash
git add web/src/routes/index.tsx
git commit -m "Make the landing page a drop target with a pending-files preview"
```

---

### Task 3: Adopt pending files in all six tool pages

**Files:**
- Modify: `web/src/routes/compress.tsx`, `merge.tsx`, `convert.tsx`, `lock.tsx`, `unlock.tsx`, `rotate.tsx`

**Interfaces:**
- Consumes: `useHandoffStore` (Task 1) and each page's existing intake function + zustand store.

**The rules (apply per page):**

1. Add `import { useHandoffStore } from "@/stores/handoff"`.
2. Widen the page's intake parameter type from `FileList | null` to `FileList | File[] | null` (every intake already uses `Array.from(incoming)`, so no body changes; for single-file pages the `incoming?.[0]` / `incoming[0]` access also works on arrays — verify per page).
3. After the intake function is defined inside the component, add the adoption effect (exact code, substituting the page's store and intake name):
```tsx
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
```
Per-page substitutions:
- compress: store `useCompressStore`, emptiness `state.files.length > 0`, intake `addFiles`
- merge: `useMergeStore`, `state.files.length > 0`, `addFiles`
- convert: `useConvertStore`, `state.files.length > 0`, `addFiles`
- lock: `useLockStore`, `state.file !== null`, intake = the function wired to its file input/Dropzone (read the file for its name)
- unlock: `useUnlockStore`, `state.file !== null`, same approach
- rotate: `useRotateStore`, `state.file !== null || state.cards.length > 0`, intake `loadFile`

- [ ] **Step 1: Apply to compress, merge, convert**
- [ ] **Step 2: Apply to lock, unlock, rotate**
- [ ] **Step 3: Gates**

Run: `cd web && bun run test && bun run typecheck && bun run build`
Expected: 23 passed, clean, green.

- [ ] **Step 4: Commit**

```bash
git add web/src/routes/compress.tsx web/src/routes/merge.tsx web/src/routes/convert.tsx web/src/routes/lock.tsx web/src/routes/unlock.tsx web/src/routes/rotate.tsx
git commit -m "Adopt landing-page files into every tool on arrival"
```

---

### Task 4 (controller): Final review, PR, merge, prod verify

- [ ] Whole-branch review (sonnet — web-only, moderate diff) with fix wave if needed.
- [ ] Push, PR, `api`+`web` checks, merge, pull main.
- [ ] Prod verify (curl only): web deploys; served bundles contain `Drop files anywhere`, `pick a tool below`, and `Active`; the sales line appears after the coffee block markup; site 200. api shows SKIPPED.
