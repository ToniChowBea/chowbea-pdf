# Landing Page Drag-and-Drop + Handoff — Design

**Date:** 2026-07-03
**Status:** Approved (owner authorized full autonomous delivery)

## Requirements (owner's words, distilled)

1. Move "No accounts, no clutter — just the eight things you actually do to a
   PDF." out of the hero to below the Buy-me-a-coffee block, as regular text.
2. Hero instead instructs: click Upload PDF or drag and drop files to
   continue.
3. The whole landing page accepts drag-and-drop. Files picked/dropped WITHOUT
   choosing a tool show a preview (file icon + count); clicking a tool then
   carries those files into that tool automatically.
4. Tool tile badge "Live" → "Active".

## Architecture — the handoff

- New `web/src/stores/handoff.ts`: `useHandoffStore` (zustand, in-memory)
  holding `files: File[]` plus a `take(): File[]` action that returns the
  current files and empties the store.
- **Adopt-on-mount, via each page's own intake.** Every tool page gains a
  mount effect: *if the page is empty and idle*, `take()` the pending files
  and feed them through the page's existing intake function (`addFiles` /
  `pickFile` / `loadFile`). This preserves each tool's validation (compress
  keeps only PDFs, convert detects kinds, rotate renders thumbnails through
  its own pipeline).
- **Check-before-take:** pages only `take()` when they will actually adopt
  (empty + idle). If a tool already has state, the pending files stay in the
  handoff store — the user can go back and pick a different tool without
  losing them. Files are never clobbered and never silently dropped.
- Intake signatures widen from `FileList | null` to
  `FileList | File[] | null` (all use `Array.from`, so this is mechanical).
- Adoption emptiness checks: compress/merge/convert →
  `files.length === 0 && status === "idle"`; lock/unlock →
  `file === null && status === "idle"`; rotate →
  `file === null && cards.length === 0 && status === "idle"`.

## Landing page (`web/src/routes/index.tsx`)

- **Page-level drop target:** dragenter/dragover/dragleave/drop on the page
  root with a depth counter (enter/leave pairs) so child elements don't
  flicker the state; overlay only when the drag actually carries files
  (`event.dataTransfer.types` includes `"Files"`). Overlay: full-page
  Bold-Blocks panel ("Drop files anywhere").
- **Upload PDF becomes a button** opening a hidden multi-file input (no
  longer a link to /compress).
- **Accepted types:** everything the site supports —
  `.pdf,.png,.jpg,.jpeg,.docx,.md,.markdown,.html,.htm,.txt` — via a new
  tiny `web/src/lib/supported-files.ts` (`SUPPORTED_ACCEPT` string +
  `isSupportedFile(file)`); unsupported files are silently filtered.
  (Convert keeps its own richer kind map; the small overlap is deliberate.)
- Intake (drop or picker) appends to the handoff store with the usual
  `name:size` dedupe.
- **Preview state** (pending files exist): the hero's button area shows a
  file icon, "N file(s) ready" with total size, a clear ✕ (empties the
  store), and the hint "Pick a tool below — your files come with you." The
  hero paragraph reads "Click Upload PDF or drag and drop files anywhere to
  get started." normally, and the preview replaces the button.
- **Copy moves:** the sales line renders below `<CoffeeBlock />` as a muted
  centered paragraph. Tile badge "Live" → "Active" ("Soon" unchanged).

## Non-goals

- Drag-and-drop on non-landing pages beyond what tools already have.
- Persisting pending files across reloads (File objects can't be persisted).
- Smart tool suggestions based on file type.

## Testing

- vitest: handoff store (set/append, `take()` returns-and-clears, take on
  empty → `[]`); `isSupportedFile` extension matrix.
- Gates: vitest, typecheck, build. NO browser testing (owner directive).
- Prod verify: served bundles contain the new copy/overlay markers; site 200.

## Delivery

Branch `landing-dnd` → subagent tasks with reviews → final whole-branch
review → PR → checks → merge → deploy verify. Fully autonomous per owner.
