# Preserve Tool State + Queue Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tool pages keep their state (files, settings, progress, results) across in-app navigation via per-tool zustand stores, and the Queue header pill toggles back to wherever the user came from.

**Architecture:** Five module-level zustand stores in `web/src/stores/` (one per tool) replace component `useState`; pages read via the store hook and write via `useXStore.setState`, so in-flight job callbacks keep landing in the store after unmount. A pure `resolveQueueToggle` helper + a small `QueueLink` component in `__root.tsx` implement the toggle.

**Tech Stack:** zustand, React, TanStack Router, vitest. Web-only — the api is untouched.

**Spec:** `docs/superpowers/specs/2026-07-03-preserve-tool-state-design.md`
**Branch:** all work on `preserve-tool-state` (already created; `main` is protected).

## Global Constraints

- **NO browser testing, NO dev servers, NO Playwright** (owner directive — they interfere with the owner's other local work). Verification is vitest + `bun run typecheck` + `bun run build` only.
- State lives in memory only; no localStorage/sessionStorage persistence.
- Queue pill remains a `Link to="/queue"` with the exact same className and the label text `Queue` (unchanged); only left-click behavior is intercepted.
- Store field names match the pages' current variable names exactly (listed per store below).
- The completeness net for each page refactor is the compiler: deleting the `useState` lines removes the old setters, so any missed call site fails `bun run typecheck`. A refactor task is NOT done until typecheck is clean.
- Commands: `cd web && bun …`. Never `git add -A` (unrelated files are dirty in the worktree).
- SSR note: module-level zustand stores are shared during server rendering. That is safe here because stores are only ever WRITTEN from user interactions (client-side); SSR renders read pristine initial state. No store writes may happen during render — reviewers should treat any render-time `setState` as a defect.

---

### Task 1: zustand, the five stores, store tests

**Files:**
- Modify: `web/package.json` + `web/bun.lock` (via `bun add zustand`)
- Create: `web/src/stores/status.ts`, `web/src/stores/compress.ts`, `web/src/stores/lock.ts`, `web/src/stores/unlock.ts`, `web/src/stores/merge.ts`, `web/src/stores/rotate.ts`
- Test: `web/src/stores/stores.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2–4): `useCompressStore`, `useLockStore`, `useUnlockStore`, `useMergeStore`, `useRotateStore` — zustand hooks whose state fields are exactly the pages' current variables plus a `reset()` action; `ToolStatus` type; `PageCard` moves to `web/src/stores/rotate.ts` (exported).

- [ ] **Step 1: Install zustand**

```bash
cd web && bun add zustand
```

- [ ] **Step 2: Write the failing store tests**

Create `web/src/stores/stores.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest"

import { useCompressStore } from "./compress"
import { useRotateStore } from "./rotate"

describe("tool stores", () => {
  beforeEach(() => {
    useCompressStore.getState().reset()
    useRotateStore.getState().reset()
  })

  it("holds state outside React, so it survives page unmounts", () => {
    useCompressStore.setState({ status: "loading" })
    expect(useCompressStore.getState().status).toBe("loading")
  })

  it("supports functional updates", () => {
    useCompressStore.setState({ files: [new File(["a"], "a.pdf")] })
    useCompressStore.setState((state) => ({
      files: [...state.files, new File(["b"], "b.pdf")],
    }))
    expect(useCompressStore.getState().files.map((f) => f.name)).toEqual(["a.pdf", "b.pdf"])
  })

  it("reset restores the initial state", () => {
    useCompressStore.setState({ status: "error", error: "boom", quality: "screen" })
    useCompressStore.getState().reset()
    expect(useCompressStore.getState()).toMatchObject({
      status: "idle",
      error: null,
      quality: "ebook",
      files: [],
    })
  })

  it("rotate store carries page cards", () => {
    useRotateStore.setState({
      cards: [{ originalIndex: 0, rotation: 90, thumbnail: null }],
    })
    expect(useRotateStore.getState().cards[0].rotation).toBe(90)
    useRotateStore.getState().reset()
    expect(useRotateStore.getState().cards).toEqual([])
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd web && bun run test`
Expected: FAIL — cannot resolve `./compress` / `./rotate`.

- [ ] **Step 4: Implement the stores**

`web/src/stores/status.ts`:
```ts
/** Lifecycle of a tool submission; shared by every tool store. */
export type ToolStatus = "idle" | "loading" | "success" | "error"
```

`web/src/stores/compress.ts`:
```ts
import { create } from "zustand"

import type {
  CompressionProgress,
  CompressionQuality,
  CompressionResult,
} from "@/lib/api"
import type { ToolStatus } from "./status"

interface CompressState {
  files: File[]
  quality: CompressionQuality
  status: ToolStatus
  result: CompressionResult | null
  error: string | null
  progress: CompressionProgress | null
  reset: () => void
}

const initialState = {
  files: [] as File[],
  quality: "ebook" as CompressionQuality,
  status: "idle" as ToolStatus,
  result: null as CompressionResult | null,
  error: null as string | null,
  progress: null as CompressionProgress | null,
}

/** Module-level store: survives route unmounts, so leaving the page mid-job
loses nothing — in-flight submit callbacks keep writing here. */
export const useCompressStore = create<CompressState>()((set) => ({
  ...initialState,
  reset: () => set(initialState),
}))
```

`web/src/stores/lock.ts`:
```ts
import { create } from "zustand"

import type { CompressionProgress, EncryptionLevel, LockResult } from "@/lib/api"
import type { ToolStatus } from "./status"

interface LockPermissions {
  allowPrinting: boolean
  allowCopying: boolean
  allowEditing: boolean
}

interface LockState {
  file: File | null
  password: string
  confirm: string
  showNew: boolean
  showConfirm: boolean
  permissions: LockPermissions
  encryption: EncryptionLevel
  status: ToolStatus
  result: LockResult | null
  error: string | null
  progress: CompressionProgress | null
  reset: () => void
}

const initialState = {
  file: null as File | null,
  password: "",
  confirm: "",
  showNew: false,
  showConfirm: false,
  permissions: { allowPrinting: true, allowCopying: false, allowEditing: false },
  encryption: "aes-256" as EncryptionLevel,
  status: "idle" as ToolStatus,
  result: null as LockResult | null,
  error: null as string | null,
  progress: null as CompressionProgress | null,
}

/** Module-level store: survives route unmounts, so leaving the page mid-job
loses nothing — in-flight submit callbacks keep writing here. */
export const useLockStore = create<LockState>()((set) => ({
  ...initialState,
  reset: () => set(initialState),
}))
```

`web/src/stores/unlock.ts`:
```ts
import { create } from "zustand"

import type { CompressionProgress, UnlockResult } from "@/lib/api"
import type { ToolStatus } from "./status"

interface UnlockState {
  file: File | null
  password: string
  showPassword: boolean
  status: ToolStatus
  result: UnlockResult | null
  error: string | null
  progress: CompressionProgress | null
  reset: () => void
}

const initialState = {
  file: null as File | null,
  password: "",
  showPassword: false,
  status: "idle" as ToolStatus,
  result: null as UnlockResult | null,
  error: null as string | null,
  progress: null as CompressionProgress | null,
}

/** Module-level store: survives route unmounts, so leaving the page mid-job
loses nothing — in-flight submit callbacks keep writing here. */
export const useUnlockStore = create<UnlockState>()((set) => ({
  ...initialState,
  reset: () => set(initialState),
}))
```

`web/src/stores/merge.ts`:
```ts
import { create } from "zustand"

import type { CompressionProgress, MergeResult } from "@/lib/api"
import type { ToolStatus } from "./status"

interface MergeState {
  files: File[]
  status: ToolStatus
  result: MergeResult | null
  error: string | null
  progress: CompressionProgress | null
  reset: () => void
}

const initialState = {
  files: [] as File[],
  status: "idle" as ToolStatus,
  result: null as MergeResult | null,
  error: null as string | null,
  progress: null as CompressionProgress | null,
}

/** Module-level store: survives route unmounts, so leaving the page mid-job
loses nothing — in-flight submit callbacks keep writing here. */
export const useMergeStore = create<MergeState>()((set) => ({
  ...initialState,
  reset: () => set(initialState),
}))
```

`web/src/stores/rotate.ts`:
```ts
import { create } from "zustand"

import type { CompressionProgress, RotateResult } from "@/lib/api"
import type { ToolStatus } from "./status"

/** One page card in the rotate grid. Moved here from the route so the store
can type its state without importing the (pdfjs-loading) route module. */
export interface PageCard {
  /** 0-based index of this page in the ORIGINAL document. */
  originalIndex: number
  /** Clockwise degrees added by the user; 0/90/180/270. */
  rotation: number
  /** Rendered thumbnail data URL, or null while still rendering. */
  thumbnail: string | null
}

interface RotateState {
  file: File | null
  cards: PageCard[]
  status: ToolStatus
  result: RotateResult | null
  error: string | null
  progress: CompressionProgress | null
  reset: () => void
}

const initialState = {
  file: null as File | null,
  cards: [] as PageCard[],
  status: "idle" as ToolStatus,
  result: null as RotateResult | null,
  error: null as string | null,
  progress: null as CompressionProgress | null,
}

/** Module-level store: survives route unmounts, so leaving the page mid-job
loses nothing — in-flight submit callbacks keep writing here. */
export const useRotateStore = create<RotateState>()((set) => ({
  ...initialState,
  reset: () => set(initialState),
}))
```

- [ ] **Step 5: Run to verify green, then typecheck**

Run: `cd web && bun run test && bun run typecheck`
Expected: vitest 8 passed (4 existing + 4 new); typecheck clean (stores are not imported by pages yet).

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/bun.lock web/src/stores/
git commit -m "Add per-tool zustand stores"
```

---

### Task 2: Refactor compress + merge pages onto their stores

**Files:**
- Modify: `web/src/routes/compress.tsx`, `web/src/routes/merge.tsx`

**Interfaces:**
- Consumes: `useCompressStore`, `useMergeStore` from Task 1.

**The transformation rules (apply to BOTH files; compress is fully worked below):**

1. Delete the page's `type Status = "idle" | ...` line and ALL `React.useState` lines listed for that page (compress: `files, quality, status, result, error, progress`; merge: `files, status, result, error, progress`).
2. Import the store: `import { useCompressStore } from "@/stores/compress"` (merge: `useMergeStore` from `@/stores/merge`).
3. First line of the component: destructure the state the JSX reads:
   `const { files, quality, status, result, error, progress } = useCompressStore()`
   (merge: without `quality`).
4. Replace every plain setter call `setX(value)` with `useCompressStore.setState({ x: value })` — including inside async handlers and callbacks (`setProgress` passed to the api helper becomes `(p) => useCompressStore.setState({ progress: p })`).
5. Replace every functional setter `setX((current) => expr)` with
   `useCompressStore.setState((state) => ({ x: <expr using state.x> }))`.
6. DOM refs (`inputRef`) stay exactly as they are.
7. Do not change any JSX beyond what the renames force.

**Worked example — compress.tsx, the three shapes that occur:**

Component top (replaces the six useState lines):
```tsx
function CompressPage() {
  const { files, quality, status, result, error, progress } = useCompressStore()
  const inputRef = React.useRef<HTMLInputElement>(null)
```

Functional update (inside `addFiles`):
```tsx
    useCompressStore.setState((state) => {
      const seen = new Set(state.files.map((f) => `${f.name}:${f.size}`))
      const unique = pdfs.filter((f) => !seen.has(`${f.name}:${f.size}`))
      return { files: [...state.files, ...unique] }
    })
    useCompressStore.setState({ status: "idle", result: null, error: null })
```

Async handler (`handleCompress`) — every write goes through the store so the
job keeps reporting after the page unmounts:
```tsx
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
```
(Reading `useCompressStore.getState().files` inside the handler instead of the
destructured `files` avoids acting on a stale closure if the list changed
between render and click; apply the same pattern in merge's `handleMerge`.)

- [ ] **Step 1: Refactor `compress.tsx` per the rules**
- [ ] **Step 2: Refactor `merge.tsx` per the rules** (its `moveFile`, `removeFile`, `addFiles` are functional updates → rule 5; `handleMerge` mirrors the async example)
- [ ] **Step 3: Gates**

Run: `cd web && bun run typecheck && bun run test`
Expected: typecheck clean (any missed setter would be a compile error — that's the completeness proof), vitest 8 passed.

- [ ] **Step 4: Commit**

```bash
git add web/src/routes/compress.tsx web/src/routes/merge.tsx
git commit -m "Move compress and merge page state into zustand stores"
```

---

### Task 3: Refactor lock + unlock pages onto their stores

**Files:**
- Modify: `web/src/routes/lock.tsx`, `web/src/routes/unlock.tsx`

**Interfaces:**
- Consumes: `useLockStore`, `useUnlockStore` from Task 1.

Apply the same seven rules as Task 2 (that task's worked example shows all
three shapes — plain set, functional set, async handler writing through the
store; repeat them here identically with the respective store).

Page-specific notes:
- lock.tsx state fields: `file, password, confirm, showNew, showConfirm, permissions, encryption, status, result, error, progress`. The permissions toggle uses a functional update over the object:
  `useLockStore.setState((state) => ({ permissions: { ...state.permissions, [key]: value } }))`.
- lock.tsx has a local `reset`/cancel handler that clears several fields — convert its setter calls one-for-one; where it resets everything to initial values, calling `useLockStore.getState().reset()` is the cleaner equivalent IF it clears exactly the full state; otherwise keep field-level setState.
- unlock.tsx state fields: `file, password, showPassword, status, result, error, progress`.
- In both submit handlers, read current values via `useLockStore.getState()` / `useUnlockStore.getState()` (not the render closure) and pass `(p) => useXStore.setState({ progress: p })` as the progress callback.

- [ ] **Step 1: Refactor `lock.tsx`**
- [ ] **Step 2: Refactor `unlock.tsx`**
- [ ] **Step 3: Gates**

Run: `cd web && bun run typecheck && bun run test`
Expected: typecheck clean, vitest 8 passed.

- [ ] **Step 4: Commit**

```bash
git add web/src/routes/lock.tsx web/src/routes/unlock.tsx
git commit -m "Move lock and unlock page state into zustand stores"
```

---

### Task 4: Refactor rotate page + Queue pill toggle

**Files:**
- Modify: `web/src/routes/rotate.tsx`, `web/src/routes/__root.tsx`
- Create: `web/src/lib/queue-toggle.ts`
- Test: `web/src/lib/queue-toggle.test.ts`

**Interfaces:**
- Consumes: `useRotateStore`, `PageCard` from `@/stores/rotate`.
- Produces: `resolveQueueToggle(currentPathname: string, remembered: string | null): { to: string; remember: string | null }`.

- [ ] **Step 1: Write the failing toggle tests**

Create `web/src/lib/queue-toggle.test.ts`:
```ts
import { describe, expect, it } from "vitest"

import { resolveQueueToggle } from "./queue-toggle"

describe("resolveQueueToggle", () => {
  it("navigates to the queue and remembers where you were", () => {
    expect(resolveQueueToggle("/rotate", null)).toEqual({ to: "/queue", remember: "/rotate" })
  })

  it("returns to the remembered location from the queue", () => {
    expect(resolveQueueToggle("/queue", "/rotate")).toEqual({ to: "/rotate", remember: "/rotate" })
  })

  it("falls back to home when the queue was the entry point", () => {
    expect(resolveQueueToggle("/queue", null)).toEqual({ to: "/", remember: null })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && bun run test`
Expected: FAIL — cannot resolve `./queue-toggle`.

- [ ] **Step 3: Implement the helper**

Create `web/src/lib/queue-toggle.ts`:
```ts
/** Decide where the Queue header pill should take the user.
 *
 * The pill is a toggle: from anywhere it goes to /queue and remembers the
 * origin; from /queue it returns to the remembered origin (home if the queue
 * was the entry point). Pure so it is trivially testable — the caller owns
 * the remembered value.
 */
export function resolveQueueToggle(
  currentPathname: string,
  remembered: string | null,
): { to: string; remember: string | null } {
  if (currentPathname === "/queue") {
    return { to: remembered ?? "/", remember: remembered }
  }
  return { to: "/queue", remember: currentPathname }
}
```

- [ ] **Step 4: Wire the toggle into `__root.tsx`**

Add imports (`Link` is already imported; add `useRouter` and `useRouterState` to the existing `@tanstack/react-router` import) and `import { resolveQueueToggle } from "@/lib/queue-toggle"`. Above `RootDocument`, add:
```tsx
// Where the user was before toggling to the queue; module scope so it
// survives re-renders without being page state.
let rememberedPath: string | null = null

/** The header Queue pill: navigates like a link but toggles back on the
second click. Middle-click / open-in-new-tab keep normal link behavior. */
function QueueLink() {
  const router = useRouter()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return (
    <Link
      to="/queue"
      onClick={(event) => {
        event.preventDefault()
        const { to, remember } = resolveQueueToggle(pathname, rememberedPath)
        rememberedPath = remember
        router.history.push(to)
      }}
      className="press inline-flex items-center gap-2 rounded-full border-2 border-ink bg-card px-5 py-2.5 text-sm font-extrabold tracking-wide text-ink uppercase shadow-block-sm"
    >
      Queue
    </Link>
  )
}
```
Replace the existing header `<Link to="/queue" className="...">Queue</Link>` with `<QueueLink />`.

- [ ] **Step 5: Refactor `rotate.tsx` onto `useRotateStore`**

Apply Task 2's seven rules with these rotate-specific points:
- Delete the local `PageCard` interface and import it: `import { type PageCard, useRotateStore } from "@/stores/rotate"` — keep `renderThumbnails` and `SortablePage` untouched except that `SortablePage`'s `card: PageCard` prop type now comes from that import.
- Component state comes from `const { file, cards, status, result, error, progress } = useRotateStore()`.
- Replace `const renderRun = React.useRef(0)` with a module-scope object ABOVE the component so every existing `renderRun.current` reference compiles unchanged:
  ```tsx
  // Cancellation token for in-flight thumbnail rendering. Module scope: a
  // remount must still be able to invalidate a previous file's render run.
  const renderRun = { current: 0 }
  ```
- All `setCards`/`setFile`/`setStatus`/`setResult`/`setError`/`setProgress` calls convert per rules 4–5 (there are functional `setCards` updates in `loadFile`'s onPage callback, `handleDragEnd`, `rotateCard`, `rotateAll`, `reset` — each becomes `useRotateStore.setState((state) => ({ cards: ... }))`).
- `handleSubmit` reads `useRotateStore.getState().file` / `.cards` and reports progress via `(p) => useRotateStore.setState({ progress: p })`.
- The page's `changed` derivation stays as-is, computed from the destructured `cards`.

- [ ] **Step 6: Gates**

Run: `cd web && bun run test && bun run typecheck && bun run build`
Expected: vitest 11 passed (8 + 3 toggle); typecheck clean; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/rotate.tsx web/src/routes/__root.tsx web/src/lib/queue-toggle.ts web/src/lib/queue-toggle.test.ts
git commit -m "Move rotate state into zustand and make the Queue pill a toggle"
```

---

### Task 5 (controller): Final review, PR, merge, deploy check

- [ ] Whole-branch review (most capable model); fix wave if needed. **No browser verification** — reviews + gates only, per owner directive.
- [ ] Push, `gh pr create`, wait for the `api`+`web` required checks, merge, pull main.
- [ ] Deploy check (curl only): Railway web deployment reaches SUCCESS for the merge commit; api shows SKIPPED; `https://pdf.chowbea.com/` returns 200.
