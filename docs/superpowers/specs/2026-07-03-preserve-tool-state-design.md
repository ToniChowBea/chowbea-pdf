# Preserve Tool State + Queue Toggle — Design

**Date:** 2026-07-03
**Status:** Approved

## Context

All five tool pages (compress, lock, unlock, merge, rotate) keep their entire
state in component-local `useState`. Navigating away (queue board, home)
unmounts the page and loses everything — selected files, settings, progress,
even finished results — although the queued job itself keeps running
server-side. The header Queue pill is a plain link, so "check the queue" means
losing your work.

## Requirements (from the owner)

1. State is preserved for all tools across in-app navigation.
2. The Queue header pill acts as a toggle: click once → queue; click again →
   back to wherever you came from. Label text unchanged.
3. State management uses **zustand** (owner's directive).

## Design

### 1. Per-tool zustand stores

- New dependency: `zustand` (~1 kB, no transitive deps of note).
- Each tool page defines a module-level store next to the component, e.g.
  `useCompressStore = create<CompressState>()(...)` with the page's full state
  and a `reset()` action restoring the initial state:
  - compress: `files: File[]`, `quality`, `status`, `result`, `error`, `progress`
  - lock: `file`, password fields/permissions/encryption, `status`, `result`, `error`, `progress`
  - unlock: `file`, `password`, `status`, `result`, `error`, `progress`
  - merge: `files: File[]`, `status`, `result`, `error`, `progress`
  - rotate: `file`, `cards: PageCard[]`, `status`, `result`, `error`, `progress`
- Components read state via the store hook and write via store setters; local
  `useRef`s that are purely DOM-related (`inputRef`) stay local. Rotate's
  `renderRun` cancellation counter moves to module scope (it already outlives
  renders conceptually).
- **Job continuation:** submit handlers write progress/result/error through
  `useXStore.setState` (callable outside React), so an in-flight
  `runJobFlow` keeps updating the store after the page unmounts. Returning to
  the tool shows live progress or the finished result with its Download
  button. Blobs live in the store until `reset()`/new file selection replaces
  them (same lifetime as today, different home).
- Store state is **in-memory only** — survives all in-app navigation; a full
  browser reload starts clean (File objects cannot be persisted; partial
  restoration of settings-without-files is worse than none).

### 2. Queue pill toggle (`web/src/routes/__root.tsx`)

- The pill remains an `<a href="/queue">`-rendering `Link` (middle-click /
  open-in-new-tab keep working; label text unchanged).
- Left-click is intercepted:
  - not on `/queue` → remember the current location (pathname+search, module
    scope) and navigate to `/queue`;
  - on `/queue` → navigate to the remembered location, `/` if none (e.g.
    landed on /queue directly).
- The decision lives in a small pure helper `resolveQueueToggle(currentPath,
  remembered)` so it is unit-testable; the component wires it to
  `router.navigate`.

### 3. Testing

- vitest: store behavior for one representative store (state survives
  "unmount" — i.e., writes via `setState` outside a component are visible to
  `getState`; `reset()` restores initial values), and `resolveQueueToggle`
  cases (from tool → queue; from queue → remembered; from queue with nothing
  remembered → `/`).
- Browser verification of the reported scenario: pick files + change settings
  on compress → click Queue → click Queue again → same files/settings;
  submit a rotate job → go home mid-processing → return → job finished with
  result present.
- Existing gates: vitest, typecheck, build.

## Out of scope (YAGNI)

- Persisting state across full page reloads.
- Preserving scroll positions.
- A global "jobs in progress" indicator in the header (nice later; not asked).

## Delivery

Branch `preserve-tool-state` → subagent tasks with reviews → final
whole-branch review → PR → checks → merge → auto-deploy (web only; api is
untouched) → browser verification on prod.
