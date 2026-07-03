# Rotate Tool — Design

**Date:** 2026-07-03
**Status:** Approved

## Context

Four tools are live (compress, lock, unlock, merge), all through the RabbitMQ
job queue: `POST /pdf/<tool>` → 202 → poll → download. The homepage Rotate tile
promises "Rotate & reorder pages" — this feature delivers the full promise:
per-page rotation AND drag-to-reorder, with in-browser thumbnails. `main` is
protected; delivery is a PR on branch `rotate-tool`.

## Decisions (approved by the owner)

- **Full scope:** per-page rotate + drag-to-reorder with thumbnails. Not a
  whole-document-only rotate.
- **New web dependencies:** `pdfjs-dist` (thumbnail rendering, lazy-loaded on
  the /rotate route only) and `@dnd-kit/core` + `@dnd-kit/sortable`
  (touch-friendly sortable grid). First new frontend deps in the project —
  both standard choices.
- **Strict permutation:** the page list must contain every original page
  exactly once. No page deletion/duplication (explicitly out of scope; the UI
  cannot produce it and the service rejects it).
- **300-page cap** in the web tool (friendly error above it). The 200 MB
  upload cap applies unchanged at submit.
- **Out of scope:** deleting/duplicating pages, inserting from other PDFs,
  undo history beyond a "Reset" that restores original order/rotations.

## API

### Service — `api/app/services/rotate.py`

- `class RotateError(RuntimeError)` — user-facing messages.
- `PageOp` — a `TypedDict` (or dataclass) `{index: int, rotation: int}`.
- `rearrange_pdf_file(input_path: Path, name: str, output_path: Path, pages: list[PageOp]) -> None`:
  - Opens the source with pikepdf; the source stays open until the output is
    saved (foreign pages copy lazily — same ExitStack/with discipline as merge).
  - Validates against the actual document: `pages` must be a permutation of
    `range(len(source.pages))` — otherwise
    `RotateError("The page list does not match the document.")`.
  - Rotations must each be one of {0, 90, 180, 270} (validated at the endpoint
    too, but re-checked here) — clockwise, applied with
    `page.rotate(rotation, relative=True)` after appending, so existing
    /Rotate values are preserved and added to.
  - Appends pages to a new `Pdf` in the order given, applies rotations, saves.
  - `pikepdf.PasswordError` / open failures map through the `name` argument:
    copy exactly `'<name>' is password-protected — unlock it first.` and
    `'<name>' could not be read as a PDF.` (matching merge).

### Endpoint — `POST /pdf/rotate` (in `api/app/routers/pdf.py`)

- Multipart: `file: UploadFile` + `pages: str = Form(...)` — a JSON array of
  `{"index": int, "rotation": int}`.
- Validation before queueing (400 on failure):
  - `pages` parses as JSON to a non-empty list of objects with integer `index`
    ≥ 0 and `rotation` in {0, 90, 180, 270}; duplicate indexes → 400
    `"The page list contains duplicates."`; unparseable/invalid → 400
    `"Invalid page list."`
  - (Permutation vs the actual document is checked in the worker/service —
    the endpoint never opens the PDF.)
- Same streaming upload validation as the other tools; workspace
  `chowbea-rotate-`; input at `workspace/input.pdf`.
- `_accept_job(tool="rotate", params={"name": safe_name, "pages": parsed})` → 202.

### Worker — `api/app/jobs/worker.py`

- `_run_rotate(record)`: input `input.pdf`, output `output.pdf`, calls
  `rearrange_pdf_file(input_path, record.params["name"], output_path,
  record.params["pages"])`; `download_name = "rotated-<name>"` (prefix rule
  like lock/unlock), `media_type="application/pdf"`. Registered as
  `"rotate"` in `_RUNNERS`; `RotateError` joins `_KNOWN_ERRORS`.

### Tests

- Service: 3-page PDF, reorder [2,0,1] with rotations [90,0,180] → output page
  order and `/Rotate` values verified with pikepdf; non-permutation (missing
  index, duplicate, out-of-range) → `RotateError`; encrypted input →
  password message; rotation preserved when the source page already has
  /Rotate (relative add).
- Worker: rotate job → done, `download_name == "rotated-a.pdf"`.
- Endpoint: valid submit → 202 with parsed `pages` in params; invalid JSON,
  bad rotation value, duplicate index → 400.

## Web

### Dependencies

- `pdfjs-dist` — imported dynamically inside the /rotate route only (route
  code-split keeps it out of every other page's bundle); worker wired via
  Vite's `?url` import of `pdfjs-dist/build/pdf.worker.min.mjs`.
- `@dnd-kit/core` + `@dnd-kit/sortable` — sortable grid with pointer + touch
  sensors.

### `web/src/lib/api.ts`

- `export interface PageOp { index: number; rotation: number }`
- `rotatePdf(file: File, pages: PageOp[], onProgress?) -> Promise<RotateResult>`
  (`RotateResult = {blob, filename}`) — form fields `file` and
  `pages` = `JSON.stringify(pages)`, via `runJobFlow` with `tool: "rotate"`,
  fallback filename `rotated-<file.name>`.

### `web/src/routes/rotate.tsx`

- Single-file dropzone. On file select: load with pdfjs (dynamic import),
  reject files over **300 pages** with an inline error ("This tool handles up
  to 300 pages — this file has N.").
- Page state: `Array<{originalIndex, rotation, thumbnail: string | null}>` in
  current display order. Thumbnails render sequentially (one at a time) into
  ~150 px canvases → data URLs; cards show a placeholder until theirs arrives.
- Card: thumbnail (CSS `transform: rotate(...)` preview), original page-number
  badge, per-card rotate button (+90° per tap, wraps at 360).
- Grid is a dnd-kit sortable; drag anywhere to reorder. Keyboard/touch
  supported by dnd-kit defaults.
- Sidebar: "Rotate all 90°" button, "Reset" (original order, all rotations 0),
  submit button "Rotate PDF" — enabled when a file is loaded AND
  (any rotation ≠ 0 OR order differs from original); same phase progress as
  the other tools (processing verb "Rotating"); success panel → download.
- Homepage tile flips to Live (`to: "/rotate"`); `TOOL_LABELS` gains
  `rotate: "Rotate"`; typed client regenerated.

## Delivery & verification

1. Branch `rotate-tool` → subagent-driven tasks with per-task review → final
   whole-branch review → PR → `api`+`web` checks → merge → auto-deploy.
2. Local: full pytest + vitest/typecheck/build; browser smoke on /rotate —
   load a 3-page PDF, rotate page 1, drag page 3 to front, submit, download;
   verify output order/rotation with pikepdf.
3. Prod: submit a rotate job via curl (pages JSON reordering a generated
   3-page PDF), poll to done, download, verify page order and /Rotate with
   pikepdf; homepage tile Live; /health commit matches.
