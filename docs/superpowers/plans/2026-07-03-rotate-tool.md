# Rotate Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rotate & reorder PDF pages — in-browser thumbnails (pdf.js), per-page +90° taps, drag-to-reorder (dnd-kit), executed by the job queue with pikepdf.

**Architecture:** Same tool pattern as merge: service module + `_RUNNERS` entry + `POST /pdf/rotate` (single file + JSON `pages` form field) + one web route. The web page renders thumbnails client-side (nothing uploads for preview), maintains an ordered `{originalIndex, rotation, thumbnail}` array, and submits `[{index, rotation}, ...]` where array order is the new page order.

**Tech Stack:** pikepdf (`Page.rotate(angle, relative=True)` — verified on installed 9.5.2), FastAPI, pytest; pdfjs-dist, @dnd-kit/core+sortable+utilities, React, vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-rotate-tool-design.md`
**Branch:** all work on `rotate-tool` (already created; `main` is protected).

## Global Constraints

- Tool id exactly `"rotate"`; params exactly `{"name": str, "pages": [{"index": int, "rotation": int}, ...]}`; input at `workspace/input.pdf`, output `workspace/output.pdf`, `download_name = "rotated-<name>"` (prefix rule like lock/unlock), `media_type="application/pdf"`
- Rotations only {0, 90, 180, 270}, clockwise, applied `relative=True`
- Strict permutation: page list must cover `range(len(source.pages))` exactly once → else `RotateError("The page list does not match the document.")`
- Endpoint 400 details exactly: `"Invalid page list."` and `"The page list contains duplicates."`
- Error copy exactly (matching merge): `'<name>' is password-protected — unlock it first.` / `'<name>' could not be read as a PDF.`
- Web: 300-page cap — error copy `This tool handles up to 300 pages — this file has N.`
- pdfjs-dist imported ONLY via dynamic `await import(...)` inside the route (SSR safety + code-split); dnd-kit static imports are fine
- api commands `cd api && uv run …`; web commands `cd web && bun …`; never `git add -A`

---

### Task 1: Rotate service

**Files:**
- Create: `api/app/services/rotate.py`
- Test: `api/tests/test_rotate_service.py`

**Interfaces:**
- Produces: `RotateError(RuntimeError)`; `rearrange_pdf_file(input_path: Path, name: str, output_path: Path, pages: list[dict]) -> None` (each dict `{"index": int, "rotation": int}`)

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_rotate_service.py`:
```python
"""Rotating and reordering PDF pages with pikepdf."""

import pikepdf
import pytest

from app.services.rotate import RotateError, rearrange_pdf_file


def make_pdf(path, pages=3):
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page()
    pdf.save(path)
    pdf.close()


def page_rotation(pdf, index):
    return int(pdf.pages[index].obj.get("/Rotate", 0))


def test_reorders_and_rotates_pages(tmp_path):
    src = tmp_path / "in.pdf"
    out = tmp_path / "out.pdf"
    make_pdf(src, pages=3)
    rearrange_pdf_file(
        src,
        "in.pdf",
        out,
        [
            {"index": 2, "rotation": 90},
            {"index": 0, "rotation": 0},
            {"index": 1, "rotation": 180},
        ],
    )
    with pikepdf.open(out) as result:
        assert len(result.pages) == 3
        assert page_rotation(result, 0) == 90
        assert page_rotation(result, 1) == 0
        assert page_rotation(result, 2) == 180


def test_rotation_adds_to_existing_rotate_value(tmp_path):
    src = tmp_path / "in.pdf"
    out = tmp_path / "out.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page()
    pdf.pages[0].rotate(90, relative=False)
    pdf.save(src)
    pdf.close()
    rearrange_pdf_file(src, "in.pdf", out, [{"index": 0, "rotation": 90}])
    with pikepdf.open(out) as result:
        assert page_rotation(result, 0) == 180


@pytest.mark.parametrize(
    "pages",
    [
        [{"index": 0, "rotation": 0}],                                # missing page 1,2
        [{"index": 0, "rotation": 0}, {"index": 0, "rotation": 0},
         {"index": 1, "rotation": 0}],                                # duplicate
        [{"index": 0, "rotation": 0}, {"index": 1, "rotation": 0},
         {"index": 5, "rotation": 0}],                                # out of range
    ],
)
def test_non_permutation_is_rejected(tmp_path, pages):
    src = tmp_path / "in.pdf"
    out = tmp_path / "out.pdf"
    make_pdf(src, pages=3)
    with pytest.raises(RotateError, match="does not match the document"):
        rearrange_pdf_file(src, "in.pdf", out, pages)


def test_invalid_rotation_is_rejected(tmp_path):
    src = tmp_path / "in.pdf"
    out = tmp_path / "out.pdf"
    make_pdf(src, pages=1)
    with pytest.raises(RotateError, match="Invalid rotation"):
        rearrange_pdf_file(src, "in.pdf", out, [{"index": 0, "rotation": 45}])


def test_encrypted_input_is_rejected(tmp_path):
    src = tmp_path / "locked.pdf"
    out = tmp_path / "out.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page()
    pdf.save(src, encryption=pikepdf.Encryption(owner="pw", user="pw", R=6))
    pdf.close()
    with pytest.raises(RotateError, match="'locked.pdf' is password-protected"):
        rearrange_pdf_file(src, "locked.pdf", out, [{"index": 0, "rotation": 0}])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_rotate_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.rotate'`.

- [ ] **Step 3: Implement the service**

Create `api/app/services/rotate.py`:
```python
"""Rotating and reordering PDF pages, backed by pikepdf.

Pages are appended to a fresh document in the caller's order (lossless page-tree
copies), then rotated relative to any rotation the page already carries. The
source must stay open until the output is saved — foreign pages copy lazily.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf

_VALID_ROTATIONS = {0, 90, 180, 270}


class RotateError(RuntimeError):
    """Raised when the pages cannot be rearranged; message is user-facing."""


def rearrange_pdf_file(
    input_path: Path,
    name: str,
    output_path: Path,
    pages: list[dict],
) -> None:
    """Write a copy of the PDF with pages reordered and rotated per `pages`.

    `pages` is the complete new page order: each entry names an original page
    index (0-based) and a clockwise rotation to add. The list must be a
    permutation of the document's pages — this tool never drops or duplicates.
    """
    for op in pages:
        if op["rotation"] not in _VALID_ROTATIONS:
            raise RotateError("Invalid rotation value.")

    try:
        source_pdf = pikepdf.open(input_path)
    except pikepdf.PasswordError as exc:
        raise RotateError(f"'{name}' is password-protected — unlock it first.") from exc
    except pikepdf.PdfError as exc:
        raise RotateError(f"'{name}' could not be read as a PDF.") from exc

    with source_pdf as source, pikepdf.new() as output:
        indexes = [op["index"] for op in pages]
        if sorted(indexes) != list(range(len(source.pages))):
            raise RotateError("The page list does not match the document.")
        for op in pages:
            output.pages.append(source.pages[op["index"]])
            if op["rotation"]:
                output.pages[-1].rotate(op["rotation"], relative=True)
        output.save(output_path)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_rotate_service.py -v`
Expected: PASS (7 passed — 5 tests, one parametrized ×3).

- [ ] **Step 5: Commit**

```bash
git add api/app/services/rotate.py api/tests/test_rotate_service.py
git commit -m "Add pikepdf rotate/reorder service"
```

---

### Task 2: Worker runner for rotate

**Files:**
- Modify: `api/app/jobs/worker.py`
- Test: `api/tests/test_worker.py` (append one test)

**Interfaces:**
- Consumes: `rearrange_pdf_file`, `RotateError` from Task 1; params `{"name", "pages"}`, input `input.pdf`.
- Produces: `_RUNNERS["rotate"]`.

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_worker.py`:
```python
def test_rotate_job_succeeds(tmp_path):
    registry = JobRegistry()
    workspace = tmp_path / "job"
    workspace.mkdir()
    write_blank_pdf(workspace / "input.pdf")
    record = registry.create(
        tool="rotate",
        workspace=workspace,
        file_count=1,
        total_bytes=(workspace / "input.pdf").stat().st_size,
        params={"name": "report.pdf", "pages": [{"index": 0, "rotation": 90}]},
    )
    asyncio.run(execute_job(registry, record.id))
    assert record.status is JobStatus.done
    assert record.error is None
    assert record.result_path is not None and record.result_path.exists()
    assert record.download_name == "rotated-report.pdf"
    assert record.media_type == "application/pdf"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && uv run pytest tests/test_worker.py::test_rotate_job_succeeds -v`
Expected: FAIL — record ends `failed` with `Unknown tool 'rotate'`.

- [ ] **Step 3: Implement**

In `api/app/jobs/worker.py`:
1. Import after the merge import:
```python
from app.services.rotate import RotateError, rearrange_pdf_file
```
2. Add `RotateError` to `_KNOWN_ERRORS`.
3. Add after `_run_merge`:
```python
def _run_rotate(record: JobRecord) -> None:
    name: str = record.params["name"]
    input_path = record.workspace / "input.pdf"
    output_path = record.workspace / "output.pdf"
    rearrange_pdf_file(input_path, name, output_path, record.params["pages"])
    record.result_path = output_path
    record.download_name = name if name.startswith("rotated-") else f"rotated-{name}"
    record.media_type = "application/pdf"
```
4. Register: `_RUNNERS = {"compress": _run_compress, "lock": _run_lock, "unlock": _run_unlock, "merge": _run_merge, "rotate": _run_rotate}`

- [ ] **Step 4: Run the full suite**

Run: `cd api && uv run pytest`
Expected: all pass (39 total).

- [ ] **Step 5: Commit**

```bash
git add api/app/jobs/worker.py api/tests/test_worker.py
git commit -m "Execute rotate jobs in the worker"
```

---

### Task 3: Rotate submit endpoint

**Files:**
- Modify: `api/app/routers/pdf.py` (add `json` import, `_parse_page_ops`, endpoint after `merge`)
- Test: `api/tests/test_submit_endpoints.py` (append)

**Interfaces:**
- Consumes: `_stream_upload_to_disk`, `_safe_name`, `_accept_job`; conftest fixtures.
- Produces: `POST /pdf/rotate` → 202 `JobAccepted`.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_submit_endpoints.py` (add `import json` at the top of the file if not present):
```python
def test_rotate_returns_202_with_parsed_pages(client, registry, fake_queue, pdf_bytes):
    pages = [{"index": 1, "rotation": 90}, {"index": 0, "rotation": 0}]
    response = client.post(
        "/pdf/rotate",
        files={"file": ("doc.pdf", pdf_bytes, "application/pdf")},
        data={"pages": json.dumps(pages)},
    )
    assert response.status_code == 202
    record = registry.get(response.json()["job_id"])
    assert record.tool == "rotate"
    assert record.params["name"] == "doc.pdf"
    assert record.params["pages"] == pages
    assert (record.workspace / "input.pdf").exists()


def test_rotate_rejects_bad_page_payloads(client, pdf_bytes):
    for raw, expected_detail in [
        ("not json", "Invalid page list."),
        ("[]", "Invalid page list."),
        ('[{"index": 0, "rotation": 45}]', "Invalid page list."),
        ('[{"index": -1, "rotation": 90}]', "Invalid page list."),
        ('[{"index": 0}]', "Invalid page list."),
        ('[{"index": 0, "rotation": 0}, {"index": 0, "rotation": 90}]',
         "The page list contains duplicates."),
    ]:
        response = client.post(
            "/pdf/rotate",
            files={"file": ("doc.pdf", pdf_bytes, "application/pdf")},
            data={"pages": raw},
        )
        assert response.status_code == 400, raw
        assert response.json()["detail"] == expected_detail, raw
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && uv run pytest tests/test_submit_endpoints.py -v`
Expected: the two new tests FAIL with 404; existing ones pass.

- [ ] **Step 3: Implement**

In `api/app/routers/pdf.py`: add `import json` to the stdlib imports, then add after the `merge` endpoint:
```python
def _parse_page_ops(raw: str) -> list[dict[str, int]]:
    """Parse and validate the rotate tool's page list; 400 on anything off."""
    invalid = HTTPException(status_code=400, detail="Invalid page list.")
    try:
        parsed = json.loads(raw)
    except ValueError:
        raise invalid from None
    if not isinstance(parsed, list) or not parsed:
        raise invalid
    ops: list[dict[str, int]] = []
    seen: set[int] = set()
    for item in parsed:
        if not isinstance(item, dict):
            raise invalid
        index = item.get("index")
        rotation = item.get("rotation")
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            raise invalid
        if isinstance(rotation, bool) or rotation not in (0, 90, 180, 270):
            raise invalid
        if index in seen:
            raise HTTPException(status_code=400, detail="The page list contains duplicates.")
        seen.add(index)
        ops.append({"index": index, "rotation": rotation})
    return ops


@router.post(
    "/rotate",
    status_code=202,
    summary="Queue a rotate/reorder of a PDF's pages",
    response_model=JobAccepted,
)
async def rotate(
    request: Request,
    file: UploadFile = File(..., description="The PDF whose pages to rotate/reorder."),
    pages: str = Form(
        ...,
        description='JSON list of {"index", "rotation"}; array order is the new page order.',
    ),
) -> JobAccepted:
    """Validate and store the upload, then queue a rotate job."""
    page_ops = _parse_page_ops(pages)

    work_dir = Path(tempfile.mkdtemp(prefix="chowbea-rotate-"))
    try:
        input_path = work_dir / "input.pdf"
        await _stream_upload_to_disk(file, input_path)
        total_bytes = input_path.stat().st_size
    except Exception:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise

    return await _accept_job(
        request,
        tool="rotate",
        workspace=work_dir,
        file_count=1,
        total_bytes=total_bytes,
        params={"name": _safe_name(file.filename, "document.pdf"), "pages": page_ops},
    )
```

- [ ] **Step 4: Run the full suite**

Run: `cd api && uv run pytest`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/app/routers/pdf.py api/tests/test_submit_endpoints.py
git commit -m "Add POST /pdf/rotate submit endpoint"
```

---

### Task 4: Web dependencies and `rotatePdf` wrapper

**Files:**
- Modify: `web/package.json` + `web/bun.lock` (via `bun add`)
- Modify: `web/src/lib/api.ts`
- Create (if missing): `web/src/vite-env.d.ts`

**Interfaces:**
- Produces: `PageOp {index: number; rotation: number}`, `RotateResult {blob, filename}`, `rotatePdf(file: File, pages: PageOp[], onProgress?) -> Promise<RotateResult>`; deps `pdfjs-dist`, `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` installed.

- [ ] **Step 1: Install dependencies**

```bash
cd web && bun add pdfjs-dist @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```
Expected: four packages added to `package.json`.

- [ ] **Step 2: Ensure vite client types exist (for `?url` imports)**

Check: `grep -rn "vite/client" web/src web/tsconfig.json` — if no hit, create `web/src/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />
```

- [ ] **Step 3: Add the api wrapper**

In `web/src/lib/api.ts`, after the merge section:
```ts
/** One page in the rotate tool's payload: original index + clockwise degrees. */
export interface PageOp {
  index: number
  rotation: number
}

/** Result of a successful rotate request. */
export interface RotateResult {
  /** The rearranged PDF. */
  blob: Blob
  /** Suggested download filename parsed from the response. */
  filename: string
}

/**
 * Rotate and/or reorder a PDF's pages. `pages` is the complete new page
 * order; each entry names an original page index and a rotation to add.
 *
 * @throws Error with the API's error detail on failure.
 */
export async function rotatePdf(
  file: File,
  pages: PageOp[],
  onProgress?: (progress: CompressionProgress) => void,
): Promise<RotateResult> {
  const form = new FormData()
  form.append("file", file)
  form.append("pages", JSON.stringify(pages))
  const download = await runJobFlow({
    tool: "rotate",
    submit: () => submitForm("/pdf/rotate", form, onProgress),
    onProgress,
  })
  return {
    blob: download.blob,
    filename: download.filename ?? `rotated-${file.name}`,
  }
}
```

- [ ] **Step 4: Verify**

Run: `cd web && bun run test && bun run typecheck`
Expected: vitest 4/4; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/bun.lock web/src/lib/api.ts web/src/vite-env.d.ts
git commit -m "Add rotate api wrapper and thumbnail/dnd dependencies"
```
(Omit `vite-env.d.ts` from the add list if it already existed.)

---

### Task 5: Rotate page, live tile, board label

**Files:**
- Create: `web/src/routes/rotate.tsx`
- Modify: `web/src/routes/index.tsx` (Rotate tile → `to: "/rotate"`), `web/src/routes/queue.tsx` (`rotate: "Rotate"` label)
- Commit also: `web/src/routeTree.gen.ts`

**Interfaces:**
- Consumes: `rotatePdf`, `PageOp`, `RotateResult`, `CompressionProgress`, `formatBytes`, `downloadBlob` from `lib/api.ts`; `Dropzone`, `ToolHeader`, `Button`, `Progress` components; dnd-kit + pdfjs-dist from Task 4.

- [ ] **Step 1: Resolve the tile icon**

Read `web/src/routes/index.tsx`, note the icon the "Rotate" tile uses, and import that icon in `rotate.tsx` for the `ToolHeader` (replace `RefreshIcon` in the code below with it if named differently; verify existence in `web/node_modules/@hugeicons/core-free-icons/dist/types/index.d.ts`).

- [ ] **Step 2: Create `web/src/routes/rotate.tsx`**

```tsx
import { createFileRoute } from "@tanstack/react-router"
import * as React from "react"
import { motion } from "motion/react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  Download04Icon,
  Loading03Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons"
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Dropzone } from "@/components/dropzone"
import { ToolHeader } from "@/components/tool-header"
import { cn } from "@/lib/utils"
import {
  type CompressionProgress,
  type RotateResult,
  downloadBlob,
  formatBytes,
  rotatePdf,
} from "@/lib/api"

export const Route = createFileRoute("/rotate")({ component: RotatePage })

const MAX_PAGES = 300

const PHASE_LABELS: Record<CompressionProgress["phase"], string> = {
  uploading: "Uploading",
  queued: "In line",
  processing: "Rotating",
  downloading: "Downloading",
}

type Status = "idle" | "loading" | "success" | "error"

interface PageCard {
  /** 0-based index of this page in the ORIGINAL document. */
  originalIndex: number
  /** Clockwise degrees added by the user; 0/90/180/270. */
  rotation: number
  /** Rendered thumbnail data URL, or null while still rendering. */
  thumbnail: string | null
}

/** Render every page to a small data-URL thumbnail, reporting one at a time.

`onCount` fires as soon as the page count is known (before any rendering), so
the grid can show placeholder cards while thumbnails stream in. */
async function renderThumbnails(
  file: File,
  onCount: (pageCount: number) => void,
  onPage: (index: number, dataUrl: string) => void,
  isCancelled: () => boolean,
): Promise<number> {
  const pdfjs = await import("pdfjs-dist")
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
  try {
    if (doc.numPages > MAX_PAGES) return doc.numPages
    onCount(doc.numPages)
    for (let i = 0; i < doc.numPages; i++) {
      if (isCancelled()) break
      const page = await doc.getPage(i + 1)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: 150 / base.width })
      const canvas = document.createElement("canvas")
      canvas.width = viewport.width
      canvas.height = viewport.height
      const context = canvas.getContext("2d")
      if (!context) break
      await page.render({ canvasContext: context, viewport }).promise
      onPage(i, canvas.toDataURL())
    }
    return doc.numPages
  } finally {
    await doc.destroy()
  }
}

function SortablePage({
  card,
  position,
  disabled,
  onRotate,
}: {
  card: PageCard
  position: number
  disabled: boolean
  onRotate: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: String(card.originalIndex), disabled })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex flex-col gap-2 rounded-[14px] border-2 border-ink bg-surface p-2.5",
        isDragging && "z-10 opacity-80 shadow-block-lg",
      )}
    >
      <div
        {...attributes}
        {...listeners}
        className="flex aspect-[3/4] cursor-grab items-center justify-center overflow-hidden rounded-[9px] border-2 border-ink bg-card active:cursor-grabbing"
      >
        {card.thumbnail ? (
          <img
            src={card.thumbnail}
            alt={`Page ${card.originalIndex + 1}`}
            style={{ transform: `rotate(${card.rotation}deg)` }}
            className="max-h-full max-w-full transition-transform"
            draggable={false}
          />
        ) : (
          <HugeiconsIcon icon={Loading03Icon} className="size-5 animate-spin text-muted-ink" />
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className="flex size-7 items-center justify-center rounded-[8px] border-2 border-ink bg-soft-amber font-heading text-[13px] font-extrabold text-ink">
          {card.originalIndex + 1}
        </span>
        <span className="text-[12px] font-bold text-muted-ink">
          {position}. {card.rotation ? `${card.rotation}°` : ""}
        </span>
        <button
          type="button"
          aria-label={`Rotate page ${card.originalIndex + 1}`}
          disabled={disabled}
          onClick={onRotate}
          className="press flex size-7 items-center justify-center rounded-[8px] border-2 border-ink text-ink disabled:opacity-30"
        >
          <HugeiconsIcon icon={RefreshIcon} className="size-4" strokeWidth={2.4} />
        </button>
      </div>
    </div>
  )
}

function RotatePage() {
  const [file, setFile] = React.useState<File | null>(null)
  const [cards, setCards] = React.useState<PageCard[]>([])
  const [status, setStatus] = React.useState<Status>("idle")
  const [result, setResult] = React.useState<RotateResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [progress, setProgress] = React.useState<CompressionProgress | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const renderRun = React.useRef(0)

  const loadFile = React.useCallback((incoming: FileList | null) => {
    const picked = incoming?.[0]
    if (!picked) return
    const isPdf =
      picked.type === "application/pdf" || picked.name.toLowerCase().endsWith(".pdf")
    if (!isPdf) return
    const run = ++renderRun.current
    setFile(picked)
    setCards([])
    setStatus("idle")
    setResult(null)
    setError(null)
    renderThumbnails(
      picked,
      (pageCount) => {
        if (renderRun.current !== run) return
        // Seed placeholder cards immediately; thumbnails stream in below.
        setCards(
          Array.from({ length: pageCount }, (_, i) => ({
            originalIndex: i,
            rotation: 0,
            thumbnail: null,
          })),
        )
      },
      (index, dataUrl) => {
        if (renderRun.current !== run) return
        setCards((current) =>
          current.map((card) =>
            card.originalIndex === index ? { ...card, thumbnail: dataUrl } : card,
          ),
        )
      },
      () => renderRun.current !== run,
    )
      .then((pageCount) => {
        if (renderRun.current !== run) return
        if (pageCount > MAX_PAGES) {
          setFile(null)
          setError(`This tool handles up to ${MAX_PAGES} pages — this file has ${pageCount}.`)
        }
      })
      .catch((err) => {
        if (renderRun.current !== run) return
        setFile(null)
        setError(
          err?.name === "PasswordException"
            ? "This PDF is password-protected — unlock it first."
            : "Couldn't read this PDF.",
        )
      })
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setCards((current) => {
      const from = current.findIndex((c) => String(c.originalIndex) === active.id)
      const to = current.findIndex((c) => String(c.originalIndex) === over.id)
      if (from < 0 || to < 0) return current
      return arrayMove(current, from, to)
    })
  }

  const rotateCard = (originalIndex: number) => {
    setCards((current) =>
      current.map((card) =>
        card.originalIndex === originalIndex
          ? { ...card, rotation: (card.rotation + 90) % 360 }
          : card,
      ),
    )
  }

  const rotateAll = () => {
    setCards((current) =>
      current.map((card) => ({ ...card, rotation: (card.rotation + 90) % 360 })),
    )
  }

  const reset = () => {
    setCards((current) =>
      [...current]
        .sort((a, b) => a.originalIndex - b.originalIndex)
        .map((card) => ({ ...card, rotation: 0 })),
    )
    setStatus("idle")
    setResult(null)
  }

  const clearFile = () => {
    renderRun.current++
    setFile(null)
    setCards([])
    setStatus("idle")
    setResult(null)
    setError(null)
  }

  const changed = cards.some((card, i) => card.rotation !== 0 || card.originalIndex !== i)
  const loading = status === "loading"

  const handleSubmit = async () => {
    if (!file || !changed) return
    setStatus("loading")
    setError(null)
    setResult(null)
    setProgress({ phase: "uploading", percent: 0 })
    try {
      const rotated = await rotatePdf(
        file,
        cards.map((card) => ({ index: card.originalIndex, rotation: card.rotation })),
        setProgress,
      )
      setResult(rotated)
      setStatus("success")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.")
      setStatus("error")
    } finally {
      setProgress(null)
    }
  }

  return (
    <div className="pb-4">
      <ToolHeader
        icon={RefreshIcon}
        title="Rotate PDF"
        subtitle="Tap to rotate pages, drag to reorder them."
      />

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(event) => loadFile(event.target.files)}
      />

      <div className="mt-8 grid grid-cols-1 items-start gap-7 lg:grid-cols-[1fr_320px]">
        {/* ── Left: page grid ── */}
        {!file ? (
          <Dropzone
            onFiles={loadFile}
            onPick={() => inputRef.current?.click()}
            title="Drop a PDF here"
            hint="One file at a time"
          />
        ) : (
          <div className="rounded-[20px] border-2 border-ink bg-card p-[22px] shadow-block-lg">
            <div className="mb-4 flex items-center justify-between">
              <span className="truncate text-[13px] font-extrabold uppercase tracking-wide text-muted-ink">
                {file.name} — {formatBytes(file.size)}
              </span>
              <button
                type="button"
                aria-label="Remove file"
                onClick={clearFile}
                className="press flex size-8 shrink-0 items-center justify-center rounded-[9px] border-2 border-ink text-ink"
              >
                <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={2.4} />
              </button>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext
                items={cards.map((c) => String(c.originalIndex))}
                strategy={rectSortingStrategy}
              >
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {cards.map((card, i) => (
                    <SortablePage
                      key={card.originalIndex}
                      card={card}
                      position={i + 1}
                      disabled={loading}
                      onRotate={() => rotateCard(card.originalIndex)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        )}

        {/* ── Right: actions ── */}
        <div className="rounded-[20px] border-2 border-ink bg-card p-6 shadow-block-lg sm:p-8">
          <div className="mb-3.5 text-[13px] font-extrabold uppercase tracking-wide text-ink">
            Rotate & reorder
          </div>
          <p className="text-[14px] font-semibold text-muted-ink">
            The grid order becomes the page order. Rotations preview instantly and
            are applied losslessly.
          </p>

          <div className="mt-5 flex flex-col gap-2.5">
            <Button variant="outline" onClick={rotateAll} disabled={!file || loading}>
              Rotate all 90°
            </Button>
            <Button variant="outline" onClick={reset} disabled={!file || loading || !changed}>
              Reset
            </Button>
          </div>

          <Button
            size="lg"
            onClick={handleSubmit}
            disabled={!file || !changed || loading}
            className="mt-6 w-full"
          >
            {loading ? (
              <>
                <HugeiconsIcon icon={Loading03Icon} className="animate-spin" />
                Rotating…
              </>
            ) : (
              "Rotate PDF"
            )}
          </Button>

          {/* Progress */}
          {loading && progress && (
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

          {/* Error (job failures and load-time rejections alike) */}
          {error && (status === "error" || status === "idle") && (
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
              <div className="font-heading text-lg font-extrabold text-ink">
                Pages rearranged
              </div>
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
```
Note for the implementer: `RefreshIcon` must be replaced by whatever icon actually exists (Step 1); if `RefreshIcon` itself doesn't exist in the free set, use the rotate-ish icon the homepage tile uses (in both the import and the two usage sites).

- [ ] **Step 3: Flip the homepage tile and add the board label**

In `web/src/routes/index.tsx`: the Rotate tile gains `to: "/rotate"` (Live style follows automatically, as with merge). In `web/src/routes/queue.tsx`, add `rotate: "Rotate"` to `TOOL_LABELS`.

- [ ] **Step 4: Verify — tests, types, build**

Run: `cd web && bun run test && bun run typecheck && bun run build`
Expected: vitest 4/4; typecheck clean; build succeeds with `/rotate` in `routeTree.gen.ts` and the pdfjs chunk emitted separately (grep the build output for `pdf.worker`).

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/rotate.tsx web/src/routes/index.tsx web/src/routes/queue.tsx web/src/routeTree.gen.ts
git commit -m "Add rotate tool page with thumbnail grid and drag reorder"
```

---

### Task 6 (controller): Codegen + browser smoke

- [ ] Start rabbit + api + web locally; regenerate the typed client against `http://127.0.0.1:8000` (temporarily edit `web/api.config.toml`, `bun api:fetch --force && bun api:generate`, revert config); typecheck; commit `web/src/services/api/`.
- [ ] Browser smoke on /rotate: load a 3-page PDF, confirm three thumbnails render, rotate page 1 (badge shows 90°), drag page 3 to the front, submit, download; verify the downloaded file with pikepdf (first page = original page 3, `/Rotate` 90 on the original page 1).

### Task 7 (controller): Final review, PR, prod verify

- [ ] Whole-branch review (most capable model) with per-task Minors for triage; fix wave if needed.
- [ ] Push, `gh pr create`, checks green, merge (auto-merge if rollup lags), pull main.
- [ ] Prod: generate a 3-page PDF, `curl -F "file=@..." -F 'pages=[{"index":2,"rotation":90},{"index":0,"rotation":0},{"index":1,"rotation":0}]' https://api-production-9ae1.up.railway.app/pdf/rotate`, poll to done, download, pikepdf-verify order + /Rotate; homepage tile Live; `/health` commit matches.
