# Split Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split one PDF into multiple files via three plain-language modes (extract / consecutive parts / every N pages), with in-browser thumbnails, drag-select, a post-job rename step, and pikepdf on the queue.

**Architecture:** Same tool pattern as rotate: `split_pdf_file` service + `_run_split` worker + `POST /pdf/split` (single file + JSON `parts` form field) + one stepped `/split` route. Modes exist only on the web; the API receives `[{"pages":[int,...]}, ...]`. Multi-part results are a ZIP; the rename step rewrites ZIP entry names client-side with `fflate`.

**Tech Stack:** pikepdf, FastAPI, pytest; pdfjs-dist (existing), fflate (new), React, zustand, vitest.

**Spec:** `docs/superpowers/specs/2026-07-15-split-tool-design.md`
**Branch:** `split-tool` (create from latest `main` before Task 1).

## Global Constraints

- Tool id exactly `"split"`; params exactly `{"name": str, "parts": [{"pages": [int, ...]}, ...]}`; input at `workspace/input.pdf`; part files under `workspace/parts/part-{i}.pdf`
- One part → that PDF as result; 2+ → ZIP `split-pdfs.zip` with entry names `{stem}-1.pdf`, `{stem}-2.pdf`, … (`stem` = original name without `.pdf`)
- Endpoint 400 detail for unparseable/empty/invalid shape: `"Invalid parts list."`; within-part duplicate indexes: `"A part lists the same page more than once."`
- Error copy exactly (matching merge): `'<name>' is password-protected — unlock it first.` / `'<name>' could not be read as a PDF.`
- Web: 300-page cap — error copy `This tool handles up to 300 pages — this file has N.`
- pdfjs-dist imported ONLY via dynamic `await import(...)` inside the route (SSR safety); `fflate` may be static-imported from a small helper module
- Modes are web-only; API does not receive or validate extract vs consecutive completeness
- api commands `cd api && uv run …`; web commands `cd web && bun …`; never `git add -A`

## File map

| File | Responsibility |
|---|---|
| `api/app/services/split.py` | pikepdf split into N output PDFs |
| `api/tests/test_split_service.py` | service unit tests |
| `api/app/jobs/worker.py` | `_run_split` + register |
| `api/tests/test_worker.py` | worker success cases |
| `api/app/routers/pdf.py` | `POST /pdf/split` + `_parse_split_parts` |
| `api/tests/test_submit_endpoints.py` | 202 + 400 cases |
| `web/src/lib/split-parts.ts` | pure helpers: every-N, defaults, normalize names, coverage |
| `web/src/lib/split-parts.test.ts` | vitest for helpers |
| `web/src/lib/rename-zip.ts` | fflate unzip → rename → rezip |
| `web/src/lib/rename-zip.test.ts` | vitest for ZIP rename |
| `web/src/lib/api.ts` | `splitPdf` |
| `web/src/stores/split.ts` | stepped UI state |
| `web/src/stores/stores.test.ts` | reset coverage |
| `web/src/routes/split.tsx` | full stepped UI |
| `web/src/routes/index.tsx` | Split tile Live |
| `web/src/routes/queue.tsx` | `split` label |
| `purpose.md` | list Split as implemented |

---

### Task 1: Split service

**Files:**
- Create: `api/app/services/split.py`
- Test: `api/tests/test_split_service.py`

**Interfaces:**
- Produces: `SplitError(RuntimeError)`; `split_pdf_file(input_path: Path, name: str, output_dir: Path, parts: list[list[int]]) -> list[Path]`

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_split_service.py`:
```python
"""Splitting a PDF into page groups with pikepdf."""

import pikepdf
import pytest

from app.services.split import SplitError, split_pdf_file


def make_pdf(path, pages=5):
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page()
    pdf.save(path)
    pdf.close()


def test_splits_into_requested_parts(tmp_path):
    src = tmp_path / "in.pdf"
    out_dir = tmp_path / "parts"
    out_dir.mkdir()
    make_pdf(src, pages=5)
    paths = split_pdf_file(src, "in.pdf", out_dir, [[0, 1], [2, 3, 4]])
    assert len(paths) == 2
    assert paths[0].name == "part-0.pdf"
    assert paths[1].name == "part-1.pdf"
    with pikepdf.open(paths[0]) as a, pikepdf.open(paths[1]) as b:
        assert len(a.pages) == 2
        assert len(b.pages) == 3


def test_rejects_empty_part(tmp_path):
    src = tmp_path / "in.pdf"
    out_dir = tmp_path / "parts"
    out_dir.mkdir()
    make_pdf(src, pages=2)
    with pytest.raises(SplitError, match="at least one page"):
        split_pdf_file(src, "in.pdf", out_dir, [[0], []])


def test_rejects_duplicate_index_in_part(tmp_path):
    src = tmp_path / "in.pdf"
    out_dir = tmp_path / "parts"
    out_dir.mkdir()
    make_pdf(src, pages=2)
    with pytest.raises(SplitError, match="same page more than once"):
        split_pdf_file(src, "in.pdf", out_dir, [[0, 0]])


def test_rejects_out_of_range_index(tmp_path):
    src = tmp_path / "in.pdf"
    out_dir = tmp_path / "parts"
    out_dir.mkdir()
    make_pdf(src, pages=2)
    with pytest.raises(SplitError, match="does not match the document"):
        split_pdf_file(src, "in.pdf", out_dir, [[0, 5]])


def test_encrypted_input_is_rejected(tmp_path):
    src = tmp_path / "locked.pdf"
    out_dir = tmp_path / "parts"
    out_dir.mkdir()
    pdf = pikepdf.new()
    pdf.add_blank_page()
    pdf.save(src, encryption=pikepdf.Encryption(owner="pw", user="pw", R=6))
    pdf.close()
    with pytest.raises(SplitError, match="'locked.pdf' is password-protected"):
        split_pdf_file(src, "locked.pdf", out_dir, [[0]])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_split_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.split'`.

- [ ] **Step 3: Implement the service**

Create `api/app/services/split.py`:
```python
"""PDF splitting backed by pikepdf.

Each part is a new document whose pages are lossless copies from the source.
The source must stay open until every part is saved — foreign pages copy lazily.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf


class SplitError(RuntimeError):
    """Raised when the PDF cannot be split; message is user-facing."""


def split_pdf_file(
    input_path: Path,
    name: str,
    output_dir: Path,
    parts: list[list[int]],
) -> list[Path]:
    """Write one PDF per part into `output_dir`; return paths in part order."""
    if not parts:
        raise SplitError("Add at least one part before splitting.")

    try:
        source_pdf = pikepdf.open(input_path)
    except pikepdf.PasswordError as exc:
        raise SplitError(f"'{name}' is password-protected — unlock it first.") from exc
    except pikepdf.PdfError as exc:
        raise SplitError(f"'{name}' could not be read as a PDF.") from exc

    output_dir.mkdir(parents=True, exist_ok=True)
    page_count = len(source_pdf.pages)
    written: list[Path] = []

    with source_pdf as source:
        for part_index, indexes in enumerate(parts):
            if not indexes:
                raise SplitError("Each part must include at least one page.")
            if len(indexes) != len(set(indexes)):
                raise SplitError("A part lists the same page more than once.")
            if any(i < 0 or i >= page_count for i in indexes):
                raise SplitError("The parts list does not match the document.")

            out_path = output_dir / f"part-{part_index}.pdf"
            with pikepdf.new() as output:
                for index in indexes:
                    output.pages.append(source.pages[index])
                output.save(out_path)
            written.append(out_path)

    return written
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_split_service.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add api/app/services/split.py api/tests/test_split_service.py
git commit -m "$(cat <<'EOF'
Add pikepdf split service for page-group PDF parts.

EOF
)"
```

---

### Task 2: Worker runner

**Files:**
- Modify: `api/app/jobs/worker.py`
- Modify: `api/tests/test_worker.py`

**Interfaces:**
- Consumes: `split_pdf_file`, `SplitError`
- Produces: `_run_split` registered as `"split"` in `_RUNNERS`

- [ ] **Step 1: Write the failing worker tests**

Append to `api/tests/test_worker.py` (reuse existing `write_blank_pdf` / imports):
```python
def test_split_job_single_part_returns_pdf(tmp_path):
    registry = JobRegistry()
    workspace = tmp_path / "job"
    workspace.mkdir()
    write_blank_pdf(workspace / "input.pdf", pages=2)
    record = registry.create(
        tool="split",
        workspace=workspace,
        file_count=1,
        total_bytes=(workspace / "input.pdf").stat().st_size,
        params={"name": "report.pdf", "parts": [{"pages": [0]}]},
    )
    asyncio.run(execute_job(registry, record.id))
    assert record.status is JobStatus.done
    assert record.error is None
    assert record.result_path is not None and record.result_path.exists()
    assert record.download_name == "report-1.pdf"
    assert record.media_type == "application/pdf"


def test_split_job_multi_part_returns_zip(tmp_path):
    registry = JobRegistry()
    workspace = tmp_path / "job"
    workspace.mkdir()
    write_blank_pdf(workspace / "input.pdf", pages=3)
    record = registry.create(
        tool="split",
        workspace=workspace,
        file_count=1,
        total_bytes=(workspace / "input.pdf").stat().st_size,
        params={"name": "report.pdf", "parts": [{"pages": [0]}, {"pages": [1, 2]}]},
    )
    asyncio.run(execute_job(registry, record.id))
    assert record.status is JobStatus.done
    assert record.download_name == "split-pdfs.zip"
    assert record.media_type == "application/zip"
    assert record.result_path is not None and record.result_path.exists()
    with zipfile.ZipFile(record.result_path) as archive:
        assert sorted(archive.namelist()) == ["report-1.pdf", "report-2.pdf"]
```

If `write_blank_pdf` does not accept `pages=`, update the helper in that file to:
```python
def write_blank_pdf(path, pages=1):
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page()
    pdf.save(path)
    pdf.close()
```
and add `import zipfile` / `import pikepdf` at the top of the test file if missing.

- [ ] **Step 2: Run to verify failure**

Run: `cd api && uv run pytest tests/test_worker.py::test_split_job_single_part_returns_pdf tests/test_worker.py::test_split_job_multi_part_returns_zip -v`
Expected: FAIL — unknown tool / status not `done`.

- [ ] **Step 3: Implement the runner**

In `api/app/jobs/worker.py`:

1. Add import:
```python
from app.services.split import SplitError, split_pdf_file
```

2. Add `SplitError` to `_KNOWN_ERRORS`.

3. Add runner (after `_run_rotate` is fine):
```python
def _run_split(record: JobRecord) -> None:
    name: str = record.params["name"]
    stem = Path(name).stem or "document"
    parts = [entry["pages"] for entry in record.params["parts"]]
    parts_dir = record.workspace / "parts"
    paths = split_pdf_file(
        record.workspace / "input.pdf",
        name,
        parts_dir,
        parts,
    )
    labeled = [(path, f"{stem}-{index + 1}.pdf") for index, path in enumerate(paths)]
    if len(labeled) == 1:
        record.result_path, record.download_name = labeled[0]
        record.media_type = "application/pdf"
        return
    archive_path = record.workspace / "split-pdfs.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, arcname in labeled:
            archive.write(path, arcname=arcname)
    record.result_path = archive_path
    record.download_name = "split-pdfs.zip"
    record.media_type = "application/zip"
```

Add `from pathlib import Path` at the top of `worker.py` if not already imported.

4. Register:
```python
_RUNNERS = {
    "compress": _run_compress,
    "lock": _run_lock,
    "unlock": _run_unlock,
    "merge": _run_merge,
    "rotate": _run_rotate,
    "convert": _run_convert,
    "split": _run_split,
}
```

- [ ] **Step 4: Run worker tests**

Run: `cd api && uv run pytest tests/test_worker.py -v`
Expected: all pass including the two new split tests.

- [ ] **Step 5: Commit**

```bash
git add api/app/jobs/worker.py api/tests/test_worker.py
git commit -m "$(cat <<'EOF'
Register split job runner with single-PDF and ZIP outputs.

EOF
)"
```

---

### Task 3: Submit endpoint

**Files:**
- Modify: `api/app/routers/pdf.py`
- Modify: `api/tests/test_submit_endpoints.py`

**Interfaces:**
- Produces: `POST /pdf/split`; `_parse_split_parts(raw: str) -> list[dict[str, list[int]]]`

- [ ] **Step 1: Write the failing endpoint tests**

Append to `api/tests/test_submit_endpoints.py`:
```python
def test_split_returns_202_with_parsed_parts(client, registry, fake_queue, pdf_bytes):
    parts = [{"pages": [0, 1]}, {"pages": [2]}]
    response = client.post(
        "/pdf/split",
        files={"file": ("doc.pdf", pdf_bytes, "application/pdf")},
        data={"parts": json.dumps(parts)},
    )
    assert response.status_code == 202
    record = registry.get(response.json()["job_id"])
    assert record.tool == "split"
    assert record.params["name"] == "doc.pdf"
    assert record.params["parts"] == parts
    assert (record.workspace / "input.pdf").exists()


def test_split_rejects_bad_parts_payloads(client, pdf_bytes):
    for raw, expected_detail in [
        ("not json", "Invalid parts list."),
        ("[]", "Invalid parts list."),
        ('[{"pages": []}]', "Invalid parts list."),
        ('[{"pages": [-1]}]', "Invalid parts list."),
        ('[{"pages": [0, 0]}]', "A part lists the same page more than once."),
        ('[{"pages": [0.5]}]', "Invalid parts list."),
        ("[" * 20000 + "]" * 20000, "Invalid parts list."),
    ]:
        response = client.post(
            "/pdf/split",
            files={"file": ("doc.pdf", pdf_bytes, "application/pdf")},
            data={"parts": raw},
        )
        assert response.status_code == 400, raw
        assert response.json()["detail"] == expected_detail, raw
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && uv run pytest tests/test_submit_endpoints.py::test_split_returns_202_with_parsed_parts tests/test_submit_endpoints.py::test_split_rejects_bad_parts_payloads -v`
Expected: FAIL — 404 or missing route.

- [ ] **Step 3: Implement parser + endpoint**

In `api/app/routers/pdf.py`, add after `_parse_page_ops`:
```python
def _parse_split_parts(raw: str) -> list[dict[str, list[int]]]:
    """Parse and validate the split tool's parts list; 400 on anything off."""
    invalid = HTTPException(status_code=400, detail="Invalid parts list.")
    try:
        parsed = json.loads(raw)
    except (ValueError, RecursionError):
        raise invalid from None
    if not isinstance(parsed, list) or not parsed:
        raise invalid
    parts: list[dict[str, list[int]]] = []
    for item in parsed:
        if not isinstance(item, dict):
            raise invalid
        pages = item.get("pages")
        if not isinstance(pages, list) or not pages:
            raise invalid
        cleaned: list[int] = []
        for page in pages:
            if isinstance(page, bool) or not isinstance(page, int) or page < 0:
                raise invalid
            cleaned.append(page)
        if len(cleaned) != len(set(cleaned)):
            raise HTTPException(
                status_code=400,
                detail="A part lists the same page more than once.",
            )
        parts.append({"pages": cleaned})
    return parts
```

Add the route (near rotate is fine):
```python
@router.post(
    "/split",
    status_code=202,
    summary="Queue a split of a PDF into page groups",
    response_model=JobAccepted,
)
async def split(
    request: Request,
    file: UploadFile = File(..., description="The PDF to split."),
    parts: str = Form(
        ...,
        description='JSON list of {"pages": [int, ...]}; each entry becomes one output PDF.',
    ),
) -> JobAccepted:
    """Validate and store the upload, then queue a split job."""
    parsed_parts = _parse_split_parts(parts)

    work_dir = Path(tempfile.mkdtemp(prefix="chowbea-split-"))
    try:
        input_path = work_dir / "input.pdf"
        await _stream_upload_to_disk(file, input_path)
        total_bytes = input_path.stat().st_size
    except Exception:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise

    return await _accept_job(
        request,
        tool="split",
        workspace=work_dir,
        file_count=1,
        total_bytes=total_bytes,
        params={
            "name": _safe_name(file.filename, "document.pdf"),
            "parts": parsed_parts,
        },
    )
```

- [ ] **Step 4: Run endpoint tests + full api suite**

Run: `cd api && uv run pytest tests/test_submit_endpoints.py tests/test_split_service.py tests/test_worker.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/app/routers/pdf.py api/tests/test_submit_endpoints.py
git commit -m "$(cat <<'EOF'
Add POST /pdf/split endpoint with parts JSON validation.

EOF
)"
```

---

### Task 4: Pure web helpers (parts + names)

**Files:**
- Create: `web/src/lib/split-parts.ts`
- Create: `web/src/lib/split-parts.test.ts`

**Interfaces:**
- Produces:
  - `partsFromEveryN(pageCount: number, n: number): number[][]`
  - `defaultPartFilenames(originalName: string, partCount: number): string[]`
  - `normalizePdfFilename(name: string): string`
  - `hasDuplicateFilenames(names: string[]): boolean`
  - `formatPageRange(pages: number[]): string` — 1-based UI string
  - `assignedPageSet(parts: number[][]): Set<number>`
  - `nextFrontier(parts: number[][]): number` — next required start index for consecutive mode (0 if empty)
  - `isContiguousFrom(pages: number[], start: number): boolean`
  - `selectionToSortedPages(selected: Set<number>): number[]`

- [ ] **Step 1: Write failing tests**

Create `web/src/lib/split-parts.test.ts`:
```typescript
import { describe, expect, it } from "vitest"
import {
  assignedPageSet,
  defaultPartFilenames,
  formatPageRange,
  hasDuplicateFilenames,
  isContiguousFrom,
  nextFrontier,
  normalizePdfFilename,
  partsFromEveryN,
  selectionToSortedPages,
} from "./split-parts"

describe("partsFromEveryN", () => {
  it("chunks evenly and leaves a shorter last part", () => {
    expect(partsFromEveryN(10, 4)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ])
  })

  it("returns one part when n >= pageCount", () => {
    expect(partsFromEveryN(3, 10)).toEqual([[0, 1, 2]])
  })
})

describe("filenames", () => {
  it("builds monotonic defaults from the stem", () => {
    expect(defaultPartFilenames("syllabus.pdf", 3)).toEqual([
      "syllabus-1.pdf",
      "syllabus-2.pdf",
      "syllabus-3.pdf",
    ])
  })

  it("normalizes to .pdf and strips path junk", () => {
    expect(normalizePdfFilename("  Chapter 1  ")).toBe("Chapter 1.pdf")
    expect(normalizePdfFilename("a.pdf")).toBe("a.pdf")
  })

  it("detects duplicate names case-insensitively", () => {
    expect(hasDuplicateFilenames(["a.pdf", "A.PDF"])).toBe(true)
    expect(hasDuplicateFilenames(["a.pdf", "b.pdf"])).toBe(false)
  })
})

describe("consecutive helpers", () => {
  it("tracks frontier and contiguous ranges", () => {
    expect(nextFrontier([])).toBe(0)
    expect(nextFrontier([[0, 1], [2]])).toBe(3)
    expect(isContiguousFrom([2, 3, 4], 2)).toBe(true)
    expect(isContiguousFrom([2, 4], 2)).toBe(false)
    expect(isContiguousFrom([3, 4], 2)).toBe(false)
  })

  it("formats 1-based ranges", () => {
    expect(formatPageRange([0])).toBe("Page 1")
    expect(formatPageRange([0, 1, 2])).toBe("Pages 1–3")
  })

  it("sorts selection", () => {
    expect(selectionToSortedPages(new Set([3, 1, 2]))).toEqual([1, 2, 3])
  })

  it("collects assigned pages", () => {
    expect([...assignedPageSet([[0], [2, 3]])].sort()).toEqual([0, 2, 3])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && bun run test src/lib/split-parts.test.ts`
Expected: FAIL — cannot resolve `./split-parts`.

- [ ] **Step 3: Implement helpers**

Create `web/src/lib/split-parts.ts`:
```typescript
/** Build equal-sized page groups; the last group may be shorter. */
export function partsFromEveryN(pageCount: number, n: number): number[][] {
  if (pageCount < 1 || n < 1) return []
  const parts: number[][] = []
  for (let start = 0; start < pageCount; start += n) {
    const pages: number[] = []
    for (let i = start; i < Math.min(start + n, pageCount); i++) pages.push(i)
    parts.push(pages)
  }
  return parts
}

/** Default download names: stem-1.pdf, stem-2.pdf, … */
export function defaultPartFilenames(originalName: string, partCount: number): string[] {
  const stem = originalName.replace(/\.pdf$/i, "") || "document"
  return Array.from({ length: partCount }, (_, i) => `${stem}-${i + 1}.pdf`)
}

/** Trim and ensure a .pdf suffix. */
export function normalizePdfFilename(name: string): string {
  const trimmed = name.trim() || "document"
  return trimmed.toLowerCase().endsWith(".pdf") ? trimmed : `${trimmed}.pdf`
}

/** True when any two names collide ignoring case. */
export function hasDuplicateFilenames(names: string[]): boolean {
  const seen = new Set<string>()
  for (const name of names) {
    const key = name.toLowerCase()
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

/** 1-based range label for a sorted 0-based page list. */
export function formatPageRange(pages: number[]): string {
  if (pages.length === 0) return ""
  const start = pages[0]! + 1
  const end = pages[pages.length - 1]! + 1
  if (start === end) return `Page ${start}`
  return `Pages ${start}–${end}`
}

export function assignedPageSet(parts: number[][]): Set<number> {
  const set = new Set<number>()
  for (const part of parts) for (const page of part) set.add(page)
  return set
}

/** Next page index that consecutive mode must start at. */
export function nextFrontier(parts: number[][]): number {
  if (parts.length === 0) return 0
  const last = parts[parts.length - 1]!
  return last[last.length - 1]! + 1
}

/** True when `pages` is a contiguous run starting at `start`. */
export function isContiguousFrom(pages: number[], start: number): boolean {
  if (pages.length === 0 || pages[0] !== start) return false
  for (let i = 1; i < pages.length; i++) {
    if (pages[i] !== pages[i - 1]! + 1) return false
  }
  return true
}

export function selectionToSortedPages(selected: Set<number>): number[] {
  return [...selected].sort((a, b) => a - b)
}
```

- [ ] **Step 4: Run tests**

Run: `cd web && bun run test src/lib/split-parts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/split-parts.ts web/src/lib/split-parts.test.ts
git commit -m "$(cat <<'EOF'
Add pure helpers for split parts, names, and consecutive rules.

EOF
)"
```

---

### Task 5: API client + ZIP rename helper

**Files:**
- Modify: `web/package.json` (add `fflate` via bun)
- Create: `web/src/lib/rename-zip.ts`
- Create: `web/src/lib/rename-zip.test.ts`
- Modify: `web/src/lib/api.ts`

**Interfaces:**
- Produces: `renameZipEntries(blob: Blob, names: string[]): Promise<Blob>`; `splitPdf(file, parts, onProgress?): Promise<SplitResult>` where `SplitResult = { blob, filename }` and `parts` is `number[][]`

- [ ] **Step 1: Install fflate**

Run: `cd web && bun add fflate`
Expected: `fflate` listed in `package.json` dependencies.

- [ ] **Step 2: Write failing rename + (optional) leave splitPdf until implement**

Create `web/src/lib/rename-zip.test.ts`:
```typescript
import { describe, expect, it } from "vitest"
import { zipSync, unzipSync, strToU8 } from "fflate"
import { renameZipEntries } from "./rename-zip"

describe("renameZipEntries", () => {
  it("rewrites entry names in order", async () => {
    const zipped = zipSync({
      "old-1.pdf": strToU8("%PDF-1"),
      "old-2.pdf": strToU8("%PDF-2"),
    })
    const blob = new Blob([zipped], { type: "application/zip" })
    const out = await renameZipEntries(blob, ["alpha.pdf", "beta.pdf"])
    const entries = unzipSync(new Uint8Array(await out.arrayBuffer()))
    expect(Object.keys(entries).sort()).toEqual(["alpha.pdf", "beta.pdf"])
    expect(new TextDecoder().decode(entries["alpha.pdf"])).toBe("%PDF-1")
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd web && bun run test src/lib/rename-zip.test.ts`
Expected: FAIL — cannot resolve `./rename-zip`.

- [ ] **Step 4: Implement rename-zip + splitPdf**

Create `web/src/lib/rename-zip.ts`:
```typescript
import { unzipSync, zipSync } from "fflate"

/**
 * Unzip `blob`, rename entries in sorted original order to `names`, re-zip.
 * `names.length` must equal the number of files in the archive.
 */
export async function renameZipEntries(blob: Blob, names: string[]): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const entries = unzipSync(bytes)
  const keys = Object.keys(entries).sort()
  if (keys.length !== names.length) {
    throw new Error("File count does not match the rename list.")
  }
  const next: Record<string, Uint8Array> = {}
  keys.forEach((key, index) => {
    next[names[index]!] = entries[key]!
  })
  const out = zipSync(next)
  // Copy into a fresh ArrayBuffer so Blob gets a real ArrayBuffer, not ArrayBufferLike.
  const copy = new Uint8Array(out.byteLength)
  copy.set(out)
  return new Blob([copy.buffer], { type: "application/zip" })
}
```

In `web/src/lib/api.ts`, after `rotatePdf`:
```typescript
/** Result of a successful split request. */
export interface SplitResult {
  /** One PDF, or a ZIP of parts. */
  blob: Blob
  /** Suggested download filename from the response. */
  filename: string
}

/**
 * Split a PDF into page groups. `parts` is an array of 0-based page index lists.
 *
 * @throws Error with the API's error detail on failure.
 */
export async function splitPdf(
  file: File,
  parts: number[][],
  onProgress?: (progress: CompressionProgress) => void,
): Promise<SplitResult> {
  const form = new FormData()
  form.append("file", file)
  form.append("parts", JSON.stringify(parts.map((pages) => ({ pages }))))
  const download = await runJobFlow({
    tool: "split",
    submit: () => submitForm("/pdf/split", form, onProgress),
    onProgress,
  })
  const stem = file.name.replace(/\.pdf$/i, "") || "document"
  const fallback = parts.length === 1 ? `${stem}-1.pdf` : "split-pdfs.zip"
  return {
    blob: download.blob,
    filename: download.filename ?? fallback,
  }
}
```

- [ ] **Step 5: Run tests**

Run: `cd web && bun run test src/lib/rename-zip.test.ts src/lib/split-parts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/bun.lock web/src/lib/rename-zip.ts web/src/lib/rename-zip.test.ts web/src/lib/api.ts
git commit -m "$(cat <<'EOF'
Add splitPdf client and fflate ZIP entry renaming.

EOF
)"
```

---

### Task 6: Split zustand store

**Files:**
- Create: `web/src/stores/split.ts`
- Modify: `web/src/stores/stores.test.ts`

**Interfaces:**
- Produces: `useSplitStore` with fields below; `reset()`

```typescript
export type SplitStep = "upload" | "mode" | "build" | "rename"
export type SplitMode = "extract" | "consecutive" | "every-n"

export interface SplitPart {
  pages: number[] // 0-based, document order
}

// state: step, file, mode, pageCount, thumbnails (string|null)[], selection (number[]),
// parts (SplitPart[]), pagesPerFile (number), status, error, progress, result (SplitResult|null),
// downloadNames (string[]), reset()
```

- [ ] **Step 1: Extend stores.test.ts with a failing reset assertion**

```typescript
import { useSplitStore } from "./split"

// inside existing describe, after other resets:
it("resets the split store", () => {
  useSplitStore.setState({
    step: "build",
    parts: [{ pages: [0] }],
    downloadNames: ["a-1.pdf"],
  })
  useSplitStore.getState().reset()
  expect(useSplitStore.getState().step).toBe("upload")
  expect(useSplitStore.getState().parts).toEqual([])
  expect(useSplitStore.getState().downloadNames).toEqual([])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && bun run test src/stores/stores.test.ts`
Expected: FAIL — cannot resolve `./split`.

- [ ] **Step 3: Implement the store**

Create `web/src/stores/split.ts`:
```typescript
import { create } from "zustand"

import type { CompressionProgress, SplitResult } from "@/lib/api"
import type { ToolStatus } from "./status"

export type SplitStep = "upload" | "mode" | "build" | "rename"
export type SplitMode = "extract" | "consecutive" | "every-n"

export interface SplitPart {
  /** 0-based page indexes in document order. */
  pages: number[]
}

interface SplitState {
  step: SplitStep
  file: File | null
  mode: SplitMode | null
  pageCount: number
  thumbnails: (string | null)[]
  /** Currently highlighted page indexes. */
  selection: number[]
  parts: SplitPart[]
  pagesPerFile: number
  status: ToolStatus
  result: SplitResult | null
  error: string | null
  progress: CompressionProgress | null
  /** Editable names on the rename step. */
  downloadNames: string[]
  reset: () => void
}

const initialState = {
  step: "upload" as SplitStep,
  file: null as File | null,
  mode: null as SplitMode | null,
  pageCount: 0,
  thumbnails: [] as (string | null)[],
  selection: [] as number[],
  parts: [] as SplitPart[],
  pagesPerFile: 10,
  status: "idle" as ToolStatus,
  result: null as SplitResult | null,
  error: null as string | null,
  progress: null as CompressionProgress | null,
  downloadNames: [] as string[],
}

export const useSplitStore = create<SplitState>()((set) => ({
  ...initialState,
  reset: () => set(initialState),
}))
```

- [ ] **Step 4: Run tests**

Run: `cd web && bun run test src/stores/stores.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/stores/split.ts web/src/stores/stores.test.ts
git commit -m "$(cat <<'EOF'
Add zustand store for the split tool stepped flow.

EOF
)"
```

---

### Task 7: Split route UI

**Files:**
- Create: `web/src/routes/split.tsx` (TanStack file route; `routeTree.gen.ts` updates on dev/build)
- Modify: `web/src/routes/index.tsx` — `to: "/split"` on Split tile
- Modify: `web/src/routes/queue.tsx` — `split: "Split"`
- Modify: `purpose.md` — list Split under Implemented

**Interfaces:**
- Consumes: `useSplitStore`, `splitPdf`, `renameZipEntries`, helpers from `split-parts`, pdf.js thumbnail pattern from `rotate.tsx`, handoff `takeMatching(isPdfFile, 1)`

- [ ] **Step 1: Scaffold the route and wire Live tile / queue / purpose**

1. Create `web/src/routes/split.tsx` with `createFileRoute("/split")` and a stub component that renders `<ToolHeader title="Split" />` and “Coming soon” text so the route registers.
2. In `web/src/routes/index.tsx`, change the Split tool to include `to: "/split"`.
3. In `web/src/routes/queue.tsx`, add `split: "Split"` to `TOOL_LABELS`.
4. In `purpose.md`, move Split into Implemented (one line: split PDF into page groups via pikepdf).

- [ ] **Step 2: Smoke the route exists**

Run: `cd web && bun run typecheck`
Expected: PASS (or only pre-existing unrelated errors). Visit `/split` in `make dev` once the tree regenerates.

- [ ] **Step 3: Implement the full stepped UI**

Replace the stub with the real page. Follow `rotate.tsx` / `lock.tsx` patterns for dropzone, progress, handoff, and styling (`ToolHeader`, `Dropzone`, `Button`, motion). Required behavior:

**Steps**
1. `upload` — single-file dropzone; on pick, set `file`, clear parts/selection, move to `mode` (or stay on upload until Continue). Prefer: file picked → enable Continue → `mode`.
2. `mode` — three cards:
   - **Extract pages** — “Pick the pages you want. Each group becomes its own PDF. Other pages are left out.”
   - **Split into parts** — “Select page ranges in order until the whole document is covered.”
   - **Split every N pages** — “Break the PDF into equal chunks (for example, every 10 pages).”
   Selecting a card sets `mode` and goes to `build`. Back → `upload`.
3. `build` — mode-specific (below). Back → `mode` (clear parts/selection).
4. On successful job → set `downloadNames` via `defaultPartFilenames`, `step: "rename"`.
5. `rename` — inputs per part + page-range hint; Download disabled if empty or `hasDuplicateFilenames`; single PDF → `downloadBlob(blob, normalizePdfFilename(name))`; ZIP → `renameZipEntries` then download as `split-pdfs.zip` (or `{stem}-split.zip`). “Split another” → `reset()`.

**Thumbnails (extract + consecutive only)**  
Copy `renderThumbnails` from `rotate.tsx` (same `MAX_PAGES = 300`, same error string). Seed `thumbnails` with nulls; stream data URLs into the store.

**Gallery selection**
- Click a page: toggle in `selection` (unless disabled).
- Pointer drag across tiles: on `pointerdown` record start index; on `pointerenter`/`pointermove` while pressed, set selection to inclusive range between start and current (contiguous).
- Extract: pages in `assignedPageSet(parts)` are disabled / not selectable.
- Consecutive: only pages `>= nextFrontier(parts)` are selectable; “Add part” requires `isContiguousFrom(sorted, frontier)`.
- “Add part” appends `{ pages: selectionToSortedPages(...) }`, clears selection.
- Parts list with remove; for consecutive, removing part `i` also drops all parts after `i` (keeps frontier consistent) — document this in a short comment.

**Every N**
- Number input bound to `pagesPerFile` (clamp 1..pageCount).
- Summary text: `` `${pageCount} pages → ${parts.length} files` `` using `partsFromEveryN`.
- No gallery required.

**Submit**
- Extract/consecutive: use `parts.map(p => p.pages)`.
- Every-N: use `partsFromEveryN(pageCount, pagesPerFile)`.
- Extract: enable when `parts.length >= 1`.
- Consecutive: enable when `assignedPageSet(parts).size === pageCount`.
- Every-N: enable when `pagesPerFile >= 1 && pageCount >= 1`.
- Call `splitPdf` with progress → on success populate rename step (do **not** auto-download).

**Handoff**
```typescript
React.useEffect(() => {
  const pending = useHandoffStore.getState().takeMatching(isPdfFile, 1)
  if (pending.length > 0) { /* set file, step upload or mode */ }
}, [])
```

Keep the file focused: local subcomponents `ModeCard`, `PageThumb`, `PartsList`, `RenameStep` in the same route file are fine for v1 (matches rotate’s style).

- [ ] **Step 4: Typecheck + unit tests**

Run:
```bash
cd web && bun run test && bun run typecheck
cd api && uv run pytest
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/split.tsx web/src/routes/index.tsx web/src/routes/queue.tsx web/src/routeTree.gen.ts purpose.md
git commit -m "$(cat <<'EOF'
Add stepped Split tool UI with three modes and rename download.

EOF
)"
```

---

### Task 8: Regenerate typed API client + browser smoke

**Files:**
- Regenerate: `web/src/services/api/_generated/*` and `web/src/services/api/_internal/openapi.json` via existing scripts

- [ ] **Step 1: With API running, regenerate**

Run (from repo root, API on :8000):
```bash
cd web && bun api:fetch && bun api:generate
```
Expected: OpenAPI includes `/pdf/split`; generated operations include `split_pdf_split_post`.

- [ ] **Step 2: Commit generated client**

```bash
git add web/src/services/api/_generated web/src/services/api/_internal/openapi.json
git commit -m "$(cat <<'EOF'
Regenerate OpenAPI client for POST /pdf/split.

EOF
)"
```

- [ ] **Step 3: Manual browser smoke (checklist)**

With `make rabbit && make dev`:

1. Homepage Split tile is Active and links to `/split`.
2. Extract: select non-contiguous pages via click; Add part twice; unused pages OK; Split → rename → download ZIP; names editable; duplicate names block download.
3. Drag-select a contiguous range; Add part works.
4. Consecutive: cannot skip frontier; must cover all pages; remove middle part clears later parts.
5. Every N: summary correct; last chunk shorter; single-part when N ≥ pageCount → single PDF download with edited name.
6. Password-protected PDF → friendly unlock-first error after submit.
7. `/queue` shows “Split” label for in-flight jobs.

- [ ] **Step 4: Open PR**

```bash
git push -u origin HEAD
gh pr create --title "Add Split tool" --body "$(cat <<'EOF'
## Summary
- pikepdf split service + queue worker + `POST /pdf/split`
- Stepped `/split` UI: extract, consecutive parts, every N pages
- Post-job rename with fflate ZIP entry rewriting

## Test plan
- [ ] pytest + vitest + typecheck green
- [ ] Browser smoke of all three modes (see plan Task 8)
- [ ] Queue board shows Split label

EOF
)"
```

---

## Spec coverage self-review

| Spec requirement | Task |
|---|---|
| Three modes with plain copy | 7 |
| Stepped flow upload → mode → build → rename | 6, 7 |
| Click + drag-select gallery | 7 |
| Extract: unused OK, page in ≤1 part | 7 |
| Consecutive: frontier + full coverage | 4, 7 |
| Every N client-side chunks | 4, 7 |
| Browser pdf.js thumbnails, 300 cap | 7 |
| pikepdf service + errors | 1 |
| `POST /pdf/split` + validation | 3 |
| Worker single PDF / ZIP naming | 2 |
| Rename after job, client-side | 5, 7 |
| fflate ZIP rename | 5 |
| Homepage + queue + handoff | 7 |
| Tests service/worker/endpoint | 1–3 |
| OpenAPI regen | 8 |

No remaining TBD placeholders. Types (`SplitPart.pages`, API `{"pages":[...]}`, store fields) are consistent across tasks.
