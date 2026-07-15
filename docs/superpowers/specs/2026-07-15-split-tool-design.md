# Split Tool — Design

**Date:** 2026-07-15
**Status:** Approved

## Context

chowbea-pdf tools run through the RabbitMQ job queue: `POST /pdf/<tool>` → 202 →
poll → download. Split is the inverse of merge for large documents: users break
one PDF into smaller files so they can upload or process sections separately.
Non-technical users need a stepped UI with plain-language modes. `main` is
protected; delivery is a PR on a feature branch.

## Decisions (approved by the owner)

- **One tool, stepped flow** at `/split` (not three homepage tiles).
- **Three modes** chosen on a dedicated step, each with clear instructions:
  1. **Extract pages** — selected pages become parts; unused pages are OK.
  2. **Split into parts** — contiguous ranges added in order until the whole
     document is covered.
  3. **Split every N pages** — equal chunks (last chunk may be shorter).
- **Build parts on the client, one job** — user may add multiple parts, then
  submit once; result is a ZIP when there are 2+ parts, a single PDF when one.
- **Browser thumbnails** via existing `pdfjs-dist` (same pattern as rotate);
  nothing uploads until Split. **300-page cap** in the web tool (same as rotate).
- **Gallery selection:** click to toggle; click-drag across thumbnails for a
  contiguous range (iCloud Photos–style).
- **Naming after the job:** a “Name your files” step with defaults
  `{stem}-1.pdf`, `{stem}-2.pdf`, …; user edits names, then downloads. Rename
  is client-side only (no second API call).
- **Engine:** pikepdf (already a dependency) — lossless page copies into new
  PDFs. Modes are web-only; the API receives only the final page groups.
- **Out of scope (YAGNI):** password-protected inputs (unlock first), reordering
  pages inside a part, server thumbnails, second rename API, multi-file input,
  deleting pages from the source as a side effect.

## User flow

1. **Upload** — one PDF via the shared dropzone / landing handoff.
2. **Choose how to split** — three cards with plain-language descriptions.
3. **Build** — mode-specific UI (gallery + parts list, or N input).
4. **Split** — upload + queue job (same progress phases as other tools).
5. **Name your files** — edit defaults, then Download.
6. **Split another** — resets the store / flow.

Back navigation between steps 1–3. After a successful job, the rename step is
the success surface (no auto-download).

## Build step (per mode)

### Shared (Extract + Split into parts)

- Page gallery with pdf.js thumbnails streaming in (reuse rotate’s approach).
- Click toggles a page in the current selection; click-drag selects a
  contiguous range.
- “Add part” commits the selection to the parts list and clears selection.
- Parts list shows Part 1, Part 2… with page ranges (1-based in the UI) and
  remove. Removing a part in “Split into parts” may require re-assigning later
  pages so coverage rules stay valid (UI re-validates).

### Extract pages

- Any non-empty selection may become a part; page order inside a part follows
  document order.
- Pages may remain unassigned.
- A page may appear in at most one part (once added, it is disabled in the
  gallery until that part is removed) — avoids duplicate content across files.
- Split enabled when ≥1 part exists.

### Split into parts

- Guided prompt: “Next part must start at page X.”
- Each part must be a contiguous range starting at X with no gaps ahead of the
  frontier.
- Progress: “N of M pages assigned.”
- Split enabled only when every page is assigned exactly once across parts.

### Split every N pages

- Number input “Pages per file” (default 10, min 1, max = page count).
- Live summary: e.g. “64 pages → 7 files (last file has 4 pages).”
- No gallery required for v1.
- Split enabled when N is valid; parts are generated client-side as
  `[[0..N-1], [N..2N-1], …]` before submit.

## API

### Service — `api/app/services/split.py`

- `class SplitError(RuntimeError)` — user-facing messages.
- `split_pdf_file(input_path: Path, name: str, output_dir: Path, parts: list[list[int]]) -> list[Path]`:
  - Opens the source with pikepdf; source stays open until all parts are saved
    (foreign pages copy lazily — same discipline as merge/rotate).
  - Each part is a non-empty list of 0-based page indexes; indexes must be in
    `range(len(source.pages))`; duplicates within a part → `SplitError`.
  - Writes `part-{i}.pdf` into `output_dir` for each part (pages appended in
    the order given).
  - `pikepdf.PasswordError` / open failures map through `name`:
    `'<name>' is password-protected — unlock it first.` and
    `'<name>' could not be read as a PDF.` (matching merge).

### Endpoint — `POST /pdf/split` (in `api/app/routers/pdf.py`)

- Multipart: `file: UploadFile` + `parts: str = Form(...)` — JSON array of
  objects `{"pages": [int, ...]}`.
- Validation before queueing (400 on failure):
  - Parses to a non-empty list; each part has a non-empty `pages` array of
    integers ≥ 0; duplicate indexes within a part → 400; unparseable → 400
    `"Invalid parts list."`
  - Cross-part completeness / extract vs consecutive rules are **not** enforced
    server-side (UI owns mode rules). Out-of-range indexes are caught in the
    worker/service when the PDF is opened.
- Same streaming upload validation as other tools; workspace
  `chowbea-split-`; input at `workspace/input.pdf`.
- `_accept_job(tool="split", params={"name": safe_name, "parts": parsed})` → 202.

### Worker — `api/app/jobs/worker.py`

- `_run_split(record)`:
  - Calls `split_pdf_file` into `workspace/parts/`.
  - Default on-disk / ZIP entry names: `{stem}-1.pdf`, `{stem}-2.pdf`, … from
    the original safe name (stem without `.pdf`).
  - One part → `result_path` that PDF, `media_type=application/pdf`.
  - Two or more → ZIP `split-pdfs.zip`, `media_type=application/zip`.
  - Registered as `"split"` in `_RUNNERS`; `SplitError` joins `_KNOWN_ERRORS`.

### Tests

- Service: 5-page PDF, parts `[[0,1],[2,3,4]]` → two outputs with 2 and 3 pages;
  empty part / duplicate index / out-of-range → `SplitError`; encrypted →
  password message.
- Worker: multi-part job → `done`, ZIP exists; single-part → PDF.
- Endpoint: valid parts → 202 with params; bad JSON / empty parts → 400.

## Web

- `web/src/stores/split.ts` — step, file, mode, pageCount, thumbnails, selection,
  parts, pagesPerFile (for every-N), status/progress/error, result blob +
  default filenames for the rename step.
- `web/src/lib/api.ts` — `splitPdf(file, parts, onProgress?)` via `runJobFlow`
  (`tool: "split"`), fallback filename `split-pdfs.zip` or `{stem}-1.pdf`.
- `web/src/routes/split.tsx` — stepped UI per User flow; gallery selection
  (click + drag-range); mode cards; rename step; Download uses edited names.
- **ZIP rename helper:** add `fflate` (small, no existing ZIP lib in the web
  app). On Download with 2+ parts: unzip the job result, rewrite entry names
  from the rename form, re-zip, then save. Single-part: `downloadBlob` with
  the edited filename only (no re-zip).
- Homepage: Split tile Live → `/split`; queue `TOOL_LABELS.split = "Split"`.
- Landing handoff: adopt emptiness + `addFile` pattern like other single-file
  tools.
- Typed client regenerated (`bun api:fetch && bun api:generate`) with the API
  running.

### Rename step rules

- Defaults: `{originalStem}-1.pdf`, `{originalStem}-2.pdf`, …
- Editable base name; always normalize to end with `.pdf`.
- Reject empty names; block Download on duplicate names.
- Show page-range hint per row (e.g. “Pages 1–5”).
- Optional: thumbnail of the first page of each part (from the already-rendered
  gallery cache) — nice-to-have, not required for v1.

## Delivery & verification

1. Branch `split-tool` → PR → `api` + `web` checks green → merge → deploy.
2. Local: pytest + vitest/typecheck/build; browser smoke of all three modes,
   drag-select, rename, single vs ZIP download.
3. Prod: curl `POST /pdf/split` with a small PDF + parts JSON, poll to `done`,
   download; homepage tile Live; `/health` commit matches.
