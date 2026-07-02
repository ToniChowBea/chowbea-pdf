# Merge Tool — Design

**Date:** 2026-07-02
**Status:** Approved

## Context

chowbea-pdf has three live tools (compress, lock, unlock), all running through the
RabbitMQ job queue: `POST /pdf/<tool>` → 202 + job id → poll `GET /jobs/{id}` →
download. Every tool is one service module + one endpoint + one web route. Merge
is the next roadmap tile ("Soon" on the homepage). `main` is protected: this
feature lands via PR with green `api`/`web` checks, then auto-deploys.

## Decisions (approved by the owner)

- **Engine:** pikepdf (already a dependency) — lossless page-tree append, no
  Ghostscript re-distilling.
- **Reordering:** upload order = merge order; the web file list gets order
  numbers and per-card ▲/▼ buttons. No drag-and-drop library.
- **Out of scope (YAGNI):** page-level selection, interleaving, drag-and-drop,
  merging password-protected files by supplying passwords.

## API

### Service — `api/app/services/merge.py`

- `class MergeError(RuntimeError)` — human-readable, shown verbatim to users.
- `merge_pdf_files(input_paths: list[Path], names: list[str], output_path: Path) -> None`
  — opens each input with pikepdf in order and appends its pages to a new `Pdf`,
  saved to `output_path`. Failure mapping (always naming the offending file):
  - `pikepdf.PasswordError` → `MergeError("'<name>' is password-protected — unlock it first.")`
  - any other pikepdf/open failure → `MergeError("'<name>' could not be read as a PDF.")`

### Endpoint — `POST /pdf/merge` (in `api/app/routers/pdf.py`)

- Multipart `files: List[UploadFile]` — same streaming validation as the other
  tools (PDF magic bytes 400, size cap 413, empty 400).
- **Minimum 2 files**; fewer → 400 `"Merging needs at least two PDF files."`
- Stores inputs as `workspace/input-{i}.pdf` (upload order = merge order), then
  `_accept_job(tool="merge", params={"names": [safe names]})` → 202 `JobAccepted`.

### Worker — `api/app/jobs/worker.py`

- `_run_merge(record)`: inputs `input-{i}.pdf` for `i in range(len(names))`,
  output `workspace/output.pdf`, `download_name="merged.pdf"`,
  `media_type="application/pdf"`. Registered as `"merge"` in `_RUNNERS`.
  `MergeError` joins `_KNOWN_ERRORS`.

### Tests

- Service: two 1-page PDFs → output has 2 pages (pikepdf-verified); encrypted
  input → `MergeError` naming the file.
- Worker: merge job → `done`, result exists, `download_name == "merged.pdf"`.
- Endpoint: 2 files → 202 with `params["names"]` in order and both inputs on
  disk; 1 file → 400.

## Web

- `web/src/lib/api.ts`: `mergePdfs(files: File[], onProgress?) -> Promise<MergeResult>`
  (`MergeResult = {blob, filename}`), via the existing `runJobFlow` with
  `tool: "merge"`, fallback filename `merged.pdf`.
- `web/src/routes/merge.tsx`: modeled on compress —
  - multi-file dropzone; file cards show a **1-based order number**, filename,
    size, ▲/▼ reorder buttons (▲ disabled on first, ▼ on last), remove button;
  - submit button "Merge N files", enabled at ≥2 files;
  - phase progress identical to the other tools (`In line — #N` / "Merging" /
    "Downloading"); success panel with Download button.
- `web/src/routes/index.tsx`: Merge tile becomes Live and links to `/merge`.
- `web/src/routes/queue.tsx`: `TOOL_LABELS` gains `merge: "Merge"`.
- Typed client regenerated (`bun api:fetch && bun api:generate`) with the api
  running.

## Delivery & verification

1. Branch `merge-tool` (this spec rides in it) → PR → `api` + `web` checks green
   → merge → Railway auto-deploys both services (both trees change).
2. Local: full pytest + vitest/typecheck/build; browser smoke of /merge
   (2 files, reorder, download).
3. Prod: submit a 2-file merge via curl to `/pdf/merge`, poll to `done`,
   download starts `%PDF`; homepage tile Live; `/health` commit matches merge
   commit.
