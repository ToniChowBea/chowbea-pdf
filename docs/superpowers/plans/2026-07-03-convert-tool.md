# Convert Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Convert tool covering PDF ↔ images/Word/Markdown/Text and full pandoc interconversion between Word/Markdown/HTML/Text, through the existing job queue.

**Architecture:** One `convert` tool: a converter registry in `services/convert.py` keyed by `(source_kind, target)`, each converter a small function shelling to the right engine (pandoc / LibreOffice / Ghostscript / weasyprint) or calling a Python lib (img2pdf / pdf2docx / pdfminer). `POST /pdf/convert` validates kind+pair+dpi and queues; the web page detects the dropped file's kind and offers only that row of the matrix.

**Tech Stack:** pandoc, LibreOffice (headless), Ghostscript, weasyprint, img2pdf, pdf2docx, pdfminer.six; FastAPI, pytest; React + zustand, vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-convert-tool-design.md`
**Branch:** all work on `convert-tool` (already created; `main` is protected).

## Global Constraints

- **NO browser testing, NO dev servers except the one codegen run by the controller, NO Playwright** (owner directive). Gates: pytest, vitest, typecheck, build.
- Tool id exactly `"convert"`; params exactly `{"target", "names", "source_kind", "dpi"?}`; inputs at `workspace/input-{i}<original suffix>`.
- `target ∈ {pdf, docx, md, html, txt, png, jpeg}`; `png/jpeg` only from `pdf`; `dpi ∈ {72, 150, 300}` only with png/jpeg, service default 150.
- Source kinds: `pdf | image | docx | md | html | txt` from extension (`.pdf`; `.png/.jpg/.jpeg`; `.docx`; `.md/.markdown`; `.html/.htm`; `.txt`).
- Allowed pairs (the matrix): pdf→{png,jpeg,docx,md,txt}; image→{pdf}; docx→{pdf,md,html,txt}; md→{pdf,html,docx,txt}; html→{pdf,md,docx,txt}; txt→{pdf,md,html,docx}.
- Error copy exactly: `Cannot convert <kind> to <target>.` / `Invalid target format.` / `Invalid DPI.` / `Unsupported file type.` / `Convert takes one file at a time (multiple images can be combined into a PDF).` / `'<name>' does not look like a <kind> file.` / `'<name>' took too long to convert.` / `'<name>' could not be converted.` / `'<name>' could not be converted (engine unavailable).` / pdf-specific: `'<name>' is password-protected — unlock it first.` and `'<name>' could not be read as a PDF.`
- Subprocess timeout 180 s. LibreOffice uses a per-job profile `-env:UserInstallation=file://<workspace>/lo-profile`.
- Heavy engine libs (weasyprint, pdf2docx) are imported LAZILY inside converter functions — the api must boot on machines without pango/LibreOffice (the owner's Mac).
- Engine-dependent tests use `pytest.mark.skipif(shutil.which(<binary>) is None, ...)` or `pytest.importorskip` so local runs stay green without engines; CI installs everything.
- Output naming: single output `<stem-of-first-input>.<ext>`; pdf→images `<stem>-pages.zip` containing `page-1.<ext>`… Media types per spec (docx = `application/vnd.openxmlformats-officedocument.wordprocessingml.document`).
- Never `git add -A`.

---

### Task 1: Dependencies — Python, Dockerfile, CI

**Files:**
- Modify: `api/pyproject.toml` + `api/uv.lock` (via uv add), `api/Dockerfile`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces: importable `img2pdf`, `pdf2docx`, `weasyprint`, `pdfminer.six`; Docker image and CI runner with `pandoc`, `soffice`, `gs`, pango libs, fonts.

- [ ] **Step 1: Add Python deps**

```bash
cd api && uv add img2pdf pdf2docx weasyprint pdfminer.six
```
Then pin each new entry in `pyproject.toml` to the exact resolved version (repo convention) and `uv sync`.

- [ ] **Step 2: Extend the Dockerfile's apt layer**

In `api/Dockerfile`, the existing Ghostscript RUN becomes (keep the comment style):
```dockerfile
# Ghostscript (`gs`) powers compression and PDF→image conversion; pandoc,
# LibreOffice, and weasyprint's pango/cairo libs power the convert tool.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ghostscript \
        pandoc \
        libreoffice-writer \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libgdk-pixbuf-2.0-0 \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 3: Extend CI's api job**

In `.github/workflows/ci.yml`, in the `api` job, add this step between checkout and `uv sync`:
```yaml
      - run: sudo apt-get update && sudo apt-get install -y --no-install-recommends pandoc libreoffice-writer ghostscript libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 fonts-liberation
```

- [ ] **Step 4: Verify**

Run: `cd api && uv run pytest` (all existing tests still pass) and `uv run python -c "import img2pdf, pdfminer; print('ok')"`
Expected: suite green; `ok`. (Do NOT import weasyprint here — it needs system libs that may be absent locally; that's why converters import it lazily.)

- [ ] **Step 5: Commit**

```bash
git add api/pyproject.toml api/uv.lock api/Dockerfile .github/workflows/ci.yml
git commit -m "Add conversion engine dependencies to api image and CI"
```

---

### Task 2: Conversion service

**Files:**
- Create: `api/app/services/convert.py`
- Test: `api/tests/test_convert_service.py`

**Interfaces:**
- Produces: `ConvertError(RuntimeError)`; `convert_files(workspace: Path, names: list[str], source_kind: str, target: str, dpi: int = 150) -> tuple[Path, str, str]` returning `(result_path, download_name, media_type)`. Inputs are expected at `workspace/input-{i}<suffix of names[i]>`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_convert_service.py`:
```python
"""Conversion service: engine wiring, naming, and error copy.

Engine-dependent tests skip when the binary/library is missing locally;
CI installs every engine, so all paths run there.
"""

import base64
import shutil
import zipfile
from pathlib import Path

import pikepdf
import pytest

from app.services.convert import ConvertError, convert_files

# A valid 1x1 transparent PNG.
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

needs_pandoc = pytest.mark.skipif(shutil.which("pandoc") is None, reason="pandoc not installed")
needs_soffice = pytest.mark.skipif(shutil.which("soffice") is None, reason="LibreOffice not installed")
needs_gs = pytest.mark.skipif(shutil.which("gs") is None, reason="Ghostscript not installed")


def write_inputs(workspace: Path, contents: list[tuple[str, bytes]]) -> list[str]:
    """Write input-{i}<suffix> files the way the endpoint does; returns names."""
    names = []
    for index, (name, data) in enumerate(contents):
        (workspace / f"input-{index}{Path(name).suffix}").write_bytes(data)
        names.append(name)
    return names


def make_pdf_bytes(pages: int = 1) -> bytes:
    import io

    buffer = io.BytesIO()
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page()
    pdf.save(buffer)
    pdf.close()
    return buffer.getvalue()


def test_images_to_pdf_combines_in_order(tmp_path):
    names = write_inputs(tmp_path, [("photo.png", TINY_PNG), ("scan.png", TINY_PNG)])
    result_path, download_name, media_type = convert_files(tmp_path, names, "image", "pdf")
    assert download_name == "photo.pdf"
    assert media_type == "application/pdf"
    with pikepdf.open(result_path) as pdf:
        assert len(pdf.pages) == 2


def test_pdf_to_txt_extracts_text(tmp_path):
    names = write_inputs(tmp_path, [("doc.pdf", make_pdf_bytes())])
    result_path, download_name, media_type = convert_files(tmp_path, names, "pdf", "txt")
    assert download_name == "doc.txt"
    assert media_type == "text/plain"
    assert result_path.exists()


def test_pdf_to_md_uses_md_extension(tmp_path):
    names = write_inputs(tmp_path, [("doc.pdf", make_pdf_bytes())])
    _, download_name, media_type = convert_files(tmp_path, names, "pdf", "md")
    assert download_name == "doc.md"
    assert media_type == "text/markdown"


def test_pdf_to_docx(tmp_path):
    names = write_inputs(tmp_path, [("doc.pdf", make_pdf_bytes())])
    result_path, download_name, media_type = convert_files(tmp_path, names, "pdf", "docx")
    assert download_name == "doc.docx"
    assert media_type.startswith("application/vnd.openxmlformats")
    assert result_path.read_bytes()[:2] == b"PK"


@needs_gs
def test_pdf_to_png_zips_pages(tmp_path):
    names = write_inputs(tmp_path, [("doc.pdf", make_pdf_bytes(pages=2))])
    result_path, download_name, media_type = convert_files(tmp_path, names, "pdf", "png", dpi=72)
    assert download_name == "doc-pages.zip"
    assert media_type == "application/zip"
    with zipfile.ZipFile(result_path) as archive:
        assert archive.namelist() == ["page-1.png", "page-2.png"]


@needs_pandoc
def test_md_to_html(tmp_path):
    names = write_inputs(tmp_path, [("notes.md", b"# Title\n\nHello.")])
    result_path, download_name, media_type = convert_files(tmp_path, names, "md", "html")
    assert download_name == "notes.html"
    assert media_type == "text/html"
    assert b"Title" in result_path.read_bytes()


@needs_pandoc
def test_md_to_docx_roundtrip_to_txt(tmp_path):
    names = write_inputs(tmp_path, [("notes.md", b"# Title\n\nHello world.")])
    docx_path, _, _ = convert_files(tmp_path, names, "md", "docx")
    workspace2 = tmp_path / "step2"
    workspace2.mkdir()
    names2 = write_inputs(workspace2, [("notes.docx", docx_path.read_bytes())])
    txt_path, download_name, _ = convert_files(workspace2, names2, "docx", "txt")
    assert download_name == "notes.txt"
    assert b"Hello world" in txt_path.read_bytes()


@needs_pandoc
@needs_soffice
def test_docx_to_pdf_via_libreoffice(tmp_path):
    md_names = write_inputs(tmp_path, [("report.md", b"# Report\n\nBody text.")])
    docx_path, _, _ = convert_files(tmp_path, md_names, "md", "docx")
    workspace2 = tmp_path / "step2"
    workspace2.mkdir()
    names2 = write_inputs(workspace2, [("report.docx", docx_path.read_bytes())])
    result_path, download_name, media_type = convert_files(workspace2, names2, "docx", "pdf")
    assert download_name == "report.pdf"
    assert media_type == "application/pdf"
    assert result_path.read_bytes()[:4] == b"%PDF"


def test_md_to_pdf_via_weasyprint(tmp_path):
    pytest.importorskip("weasyprint")
    if shutil.which("pandoc") is None:
        pytest.skip("pandoc not installed")
    names = write_inputs(tmp_path, [("notes.md", b"# Title\n\nHello.")])
    result_path, download_name, media_type = convert_files(tmp_path, names, "md", "pdf")
    assert download_name == "notes.pdf"
    assert result_path.read_bytes()[:4] == b"%PDF"


def test_txt_to_pdf_via_weasyprint(tmp_path):
    pytest.importorskip("weasyprint")
    names = write_inputs(tmp_path, [("log.txt", b"line one\nline <two> & three")])
    result_path, download_name, _ = convert_files(tmp_path, names, "txt", "pdf")
    assert download_name == "log.pdf"
    assert result_path.read_bytes()[:4] == b"%PDF"


def test_encrypted_pdf_is_rejected_with_unlock_copy(tmp_path):
    import io

    buffer = io.BytesIO()
    pdf = pikepdf.new()
    pdf.add_blank_page()
    pdf.save(buffer, encryption=pikepdf.Encryption(owner="pw", user="pw", R=6))
    pdf.close()
    names = write_inputs(tmp_path, [("locked.pdf", buffer.getvalue())])
    with pytest.raises(ConvertError, match="'locked.pdf' is password-protected"):
        convert_files(tmp_path, names, "pdf", "txt")


def test_unknown_pair_is_rejected(tmp_path):
    names = write_inputs(tmp_path, [("photo.png", TINY_PNG)])
    with pytest.raises(ConvertError, match="Cannot convert image to docx"):
        convert_files(tmp_path, names, "image", "docx")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && uv run pytest tests/test_convert_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.convert'`.

- [ ] **Step 3: Implement the service**

Create `api/app/services/convert.py`:
```python
"""File conversions across PDF, images, Word, Markdown, HTML, and text.

Each supported (source, target) pair maps to a small converter that shells to
the right engine (pandoc, LibreOffice, Ghostscript) or calls a Python library
(img2pdf, pdf2docx, pdfminer, weasyprint). Heavy libraries are imported lazily
inside the converters so the API boots on machines without the engines — a
missing engine fails the individual job, never the process.
"""

from __future__ import annotations

import html as html_module
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import Callable

import pikepdf

_TIMEOUT_SECONDS = 180

_MEDIA_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "md": "text/markdown",
    "html": "text/html",
    "txt": "text/plain",
}

# pandoc reader/writer names per our kind/target vocabulary.
_PANDOC_READERS = {"docx": "docx", "md": "markdown", "html": "html", "txt": "markdown"}
_PANDOC_WRITERS = {"docx": "docx", "md": "markdown", "html": "html", "txt": "plain"}


class ConvertError(RuntimeError):
    """Raised when a conversion cannot be performed; message is user-facing."""


def _require(binary: str, name: str) -> str:
    found = shutil.which(binary)
    if found is None:
        raise ConvertError(f"'{name}' could not be converted (engine unavailable).")
    return found


def _run(cmd: list[str], name: str) -> None:
    try:
        completed = subprocess.run(cmd, capture_output=True, timeout=_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        raise ConvertError(f"'{name}' took too long to convert.") from exc
    if completed.returncode != 0:
        raise ConvertError(f"'{name}' could not be converted.")


def _check_pdf_readable(input_path: Path, name: str) -> None:
    try:
        with pikepdf.open(input_path):
            pass
    except pikepdf.PasswordError as exc:
        raise ConvertError(f"'{name}' is password-protected — unlock it first.") from exc
    except pikepdf.PdfError as exc:
        raise ConvertError(f"'{name}' could not be read as a PDF.") from exc


def _input_paths(workspace: Path, names: list[str]) -> list[Path]:
    # The endpoint stores inputs with lowercased suffixes; mirror that here.
    return [workspace / f"input-{i}{Path(name).suffix.lower()}" for i, name in enumerate(names)]


def _images_to_pdf(workspace: Path, names: list[str], output: Path, dpi: int) -> None:
    import img2pdf

    paths = [str(p) for p in _input_paths(workspace, names)]
    try:
        output.write_bytes(img2pdf.convert(paths))
    except Exception as exc:  # noqa: BLE001 - any img2pdf failure is user-facing
        raise ConvertError(f"'{names[0]}' could not be converted.") from exc


def _pdf_to_images(workspace: Path, names: list[str], output: Path, dpi: int, ext: str) -> None:
    name = names[0]
    input_path = _input_paths(workspace, names)[0]
    _check_pdf_readable(input_path, name)
    gs = _require("gs", name)
    device = "png16m" if ext == "png" else "jpeg"
    pages_dir = workspace / "pages"
    pages_dir.mkdir(exist_ok=True)
    _run(
        [gs, "-dSAFER", "-dBATCH", "-dNOPAUSE", f"-sDEVICE={device}", f"-r{dpi}",
         "-o", str(pages_dir / f"page-%d.{ext}"), str(input_path)],
        name,
    )
    pages = sorted(pages_dir.glob(f"page-*.{ext}"), key=lambda p: int(p.stem.split("-")[1]))
    if not pages:
        raise ConvertError(f"'{name}' could not be converted.")
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for page in pages:
            archive.write(page, arcname=page.name)


def _pdf_to_docx(workspace: Path, names: list[str], output: Path, dpi: int) -> None:
    name = names[0]
    input_path = _input_paths(workspace, names)[0]
    _check_pdf_readable(input_path, name)
    from pdf2docx import Converter

    try:
        converter = Converter(str(input_path))
        try:
            converter.convert(str(output))
        finally:
            converter.close()
    except ConvertError:
        raise
    except Exception as exc:  # noqa: BLE001 - engine internals vary widely
        raise ConvertError(f"'{name}' could not be converted.") from exc


def _pdf_to_text(workspace: Path, names: list[str], output: Path, dpi: int) -> None:
    name = names[0]
    input_path = _input_paths(workspace, names)[0]
    _check_pdf_readable(input_path, name)
    from pdfminer.high_level import extract_text

    try:
        text = extract_text(str(input_path)) or ""
    except Exception as exc:  # noqa: BLE001
        raise ConvertError(f"'{name}' could not be converted.") from exc
    output.write_text(text, encoding="utf-8")


def _pandoc(source_kind: str, target: str) -> Callable[[Path, list[str], Path, int], None]:
    reader = _PANDOC_READERS[source_kind]
    writer = _PANDOC_WRITERS[target]

    def _convert(workspace: Path, names: list[str], output: Path, dpi: int) -> None:
        name = names[0]
        pandoc = _require("pandoc", name)
        input_path = _input_paths(workspace, names)[0]
        _run([pandoc, str(input_path), "-f", reader, "-t", writer, "-o", str(output)], name)
        if not output.exists():
            raise ConvertError(f"'{name}' could not be converted.")

    return _convert


def _docx_to_pdf(workspace: Path, names: list[str], output: Path, dpi: int) -> None:
    name = names[0]
    soffice = _require("soffice", name)
    input_path = _input_paths(workspace, names)[0]
    profile = workspace / "lo-profile"
    profile.mkdir(exist_ok=True)
    _run(
        [soffice, f"-env:UserInstallation=file://{profile}", "--headless",
         "--convert-to", "pdf", "--outdir", str(workspace), str(input_path)],
        name,
    )
    produced = workspace / f"{input_path.stem}.pdf"
    if not produced.exists():
        raise ConvertError(f"'{name}' could not be converted.")
    produced.replace(output)


def _html_file_to_pdf(html_path: Path, output: Path, name: str) -> None:
    try:
        from weasyprint import HTML
    except Exception as exc:  # noqa: BLE001 - missing system libs land here
        raise ConvertError(f"'{name}' could not be converted (engine unavailable).") from exc
    try:
        HTML(filename=str(html_path)).write_pdf(str(output))
    except Exception as exc:  # noqa: BLE001
        raise ConvertError(f"'{name}' could not be converted.") from exc


def _html_to_pdf(workspace: Path, names: list[str], output: Path, dpi: int) -> None:
    _html_file_to_pdf(_input_paths(workspace, names)[0], output, names[0])


def _md_to_pdf(workspace: Path, names: list[str], output: Path, dpi: int) -> None:
    name = names[0]
    pandoc = _require("pandoc", name)
    input_path = _input_paths(workspace, names)[0]
    intermediate = workspace / "intermediate.html"
    _run([pandoc, str(input_path), "-f", "markdown", "-t", "html", "-s", "-o", str(intermediate)], name)
    _html_file_to_pdf(intermediate, output, name)


def _txt_to_pdf(workspace: Path, names: list[str], output: Path, dpi: int) -> None:
    name = names[0]
    input_path = _input_paths(workspace, names)[0]
    text = input_path.read_text(encoding="utf-8", errors="replace")
    intermediate = workspace / "intermediate.html"
    intermediate.write_text(
        "<html><body><pre style=\"font-family: monospace; white-space: pre-wrap;\">"
        f"{html_module.escape(text)}</pre></body></html>",
        encoding="utf-8",
    )
    _html_file_to_pdf(intermediate, output, name)


# (source_kind, target) → converter(workspace, names, output_path, dpi).
_CONVERTERS: dict[tuple[str, str], Callable[[Path, list[str], Path, int], None]] = {
    ("image", "pdf"): _images_to_pdf,
    ("pdf", "png"): lambda w, n, o, d: _pdf_to_images(w, n, o, d, "png"),
    ("pdf", "jpeg"): lambda w, n, o, d: _pdf_to_images(w, n, o, d, "jpeg"),
    ("pdf", "docx"): _pdf_to_docx,
    ("pdf", "md"): _pdf_to_text,
    ("pdf", "txt"): _pdf_to_text,
    ("docx", "pdf"): _docx_to_pdf,
    ("docx", "md"): _pandoc("docx", "md"),
    ("docx", "html"): _pandoc("docx", "html"),
    ("docx", "txt"): _pandoc("docx", "txt"),
    ("md", "pdf"): _md_to_pdf,
    ("md", "html"): _pandoc("md", "html"),
    ("md", "docx"): _pandoc("md", "docx"),
    ("md", "txt"): _pandoc("md", "txt"),
    ("html", "pdf"): _html_to_pdf,
    ("html", "md"): _pandoc("html", "md"),
    ("html", "docx"): _pandoc("html", "docx"),
    ("html", "txt"): _pandoc("html", "txt"),
    ("txt", "pdf"): _txt_to_pdf,
    ("txt", "md"): _pandoc("txt", "md"),
    ("txt", "html"): _pandoc("txt", "html"),
    ("txt", "docx"): _pandoc("txt", "docx"),
}


def convert_files(
    workspace: Path,
    names: list[str],
    source_kind: str,
    target: str,
    dpi: int = 150,
) -> tuple[Path, str, str]:
    """Convert the staged inputs; returns (result_path, download_name, media_type)."""
    converter = _CONVERTERS.get((source_kind, target))
    if converter is None:
        raise ConvertError(f"Cannot convert {source_kind} to {target}.")

    stem = Path(names[0]).stem or "converted"
    if target in ("png", "jpeg"):
        download_name = f"{stem}-pages.zip"
        media_type = "application/zip"
        output = workspace / "output.zip"
    else:
        download_name = f"{stem}.{target}"
        media_type = _MEDIA_TYPES[target]
        output = workspace / f"output.{target}"

    converter(workspace, names, output, dpi)
    return output, download_name, media_type
```

- [ ] **Step 4: Run tests**

Run: `cd api && uv run pytest tests/test_convert_service.py -v`
Expected: pure-Python tests PASS; engine tests PASS or SKIP depending on local binaries (all must PASS in CI later). No failures.

- [ ] **Step 5: Commit**

```bash
git add api/app/services/convert.py api/tests/test_convert_service.py
git commit -m "Add conversion service with engine registry"
```

---

### Task 3: Worker runner for convert

**Files:**
- Modify: `api/app/jobs/worker.py`
- Test: `api/tests/test_worker.py` (append)

**Interfaces:**
- Consumes: `convert_files`, `ConvertError` from Task 2; params `{"target","names","source_kind","dpi"?}`.
- Produces: `_RUNNERS["convert"]`.

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_worker.py`:
```python
def test_convert_job_succeeds_with_engine_free_pair(tmp_path):
    registry = JobRegistry()
    workspace = tmp_path / "job"
    workspace.mkdir()
    write_blank_pdf(workspace / "input-0.pdf")
    record = registry.create(
        tool="convert",
        workspace=workspace,
        file_count=1,
        total_bytes=(workspace / "input-0.pdf").stat().st_size,
        params={"target": "txt", "names": ["doc.pdf"], "source_kind": "pdf"},
    )
    asyncio.run(execute_job(registry, record.id))
    assert record.status is JobStatus.done
    assert record.error is None
    assert record.download_name == "doc.txt"
    assert record.media_type == "text/plain"
    assert record.result_path is not None and record.result_path.exists()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && uv run pytest tests/test_worker.py::test_convert_job_succeeds_with_engine_free_pair -v`
Expected: FAIL — record failed with `Unknown tool 'convert'`.

- [ ] **Step 3: Implement**

In `api/app/jobs/worker.py`:
1. Import: `from app.services.convert import ConvertError, convert_files`
2. Add `ConvertError` to `_KNOWN_ERRORS`.
3. Add after `_run_rotate`:
```python
def _run_convert(record: JobRecord) -> None:
    result_path, download_name, media_type = convert_files(
        record.workspace,
        record.params["names"],
        record.params["source_kind"],
        record.params["target"],
        record.params.get("dpi") or 150,
    )
    record.result_path = result_path
    record.download_name = download_name
    record.media_type = media_type
```
4. Register `"convert": _run_convert` in `_RUNNERS`.

- [ ] **Step 4: Full suite**

Run: `cd api && uv run pytest`
Expected: green (engine tests may skip locally).

- [ ] **Step 5: Commit**

```bash
git add api/app/jobs/worker.py api/tests/test_worker.py
git commit -m "Execute convert jobs in the worker"
```

---

### Task 4: Convert submit endpoint with kind-aware validation

**Files:**
- Modify: `api/app/routers/pdf.py`
- Test: `api/tests/test_submit_endpoints.py` (append)

**Interfaces:**
- Consumes: `_safe_name`, `_accept_job` (existing); conftest fixtures.
- Produces: `POST /pdf/convert` → 202 `JobAccepted`.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_submit_endpoints.py` (TINY_PNG import shown below is new):
```python
from tests.test_convert_service import TINY_PNG


def test_convert_md_to_docx_returns_202(client, registry, fake_queue):
    response = client.post(
        "/pdf/convert",
        files=[("files", ("notes.md", b"# Hi", "text/markdown"))],
        data={"target": "docx"},
    )
    assert response.status_code == 202
    record = registry.get(response.json()["job_id"])
    assert record.tool == "convert"
    assert record.params == {"target": "docx", "names": ["notes.md"], "source_kind": "md"}
    assert (record.workspace / "input-0.md").exists()


def test_convert_pdf_to_png_with_dpi(client, registry, pdf_bytes):
    response = client.post(
        "/pdf/convert",
        files=[("files", ("doc.pdf", pdf_bytes, "application/pdf"))],
        data={"target": "png", "dpi": "300"},
    )
    assert response.status_code == 202
    record = registry.get(response.json()["job_id"])
    assert record.params["dpi"] == 300


def test_convert_multiple_images_to_pdf(client, registry):
    response = client.post(
        "/pdf/convert",
        files=[
            ("files", ("a.png", TINY_PNG, "image/png")),
            ("files", ("b.png", TINY_PNG, "image/png")),
        ],
        data={"target": "pdf"},
    )
    assert response.status_code == 202
    record = registry.get(response.json()["job_id"])
    assert record.params["source_kind"] == "image"
    assert record.params["names"] == ["a.png", "b.png"]
    assert (record.workspace / "input-1.png").exists()


def test_convert_rejections(client, pdf_bytes):
    cases = [
        # multiple non-image files
        (
            [("files", ("a.pdf", pdf_bytes, "application/pdf")),
             ("files", ("b.pdf", pdf_bytes, "application/pdf"))],
            {"target": "txt"},
            "Convert takes one file at a time (multiple images can be combined into a PDF).",
        ),
        # invalid pair
        (
            [("files", ("a.png", TINY_PNG, "image/png"))],
            {"target": "docx"},
            "Cannot convert image to docx.",
        ),
        # bad target
        (
            [("files", ("doc.pdf", pdf_bytes, "application/pdf"))],
            {"target": "gif"},
            "Invalid target format.",
        ),
        # dpi with a non-image target
        (
            [("files", ("doc.pdf", pdf_bytes, "application/pdf"))],
            {"target": "txt", "dpi": "150"},
            "Invalid DPI.",
        ),
        # dpi outside presets
        (
            [("files", ("doc.pdf", pdf_bytes, "application/pdf"))],
            {"target": "png", "dpi": "90"},
            "Invalid DPI.",
        ),
        # unknown extension
        (
            [("files", ("archive.tar", b"data", "application/x-tar"))],
            {"target": "pdf"},
            "Unsupported file type.",
        ),
        # extension/content mismatch (a "docx" that is really a PDF)
        (
            [("files", ("fake.docx", pdf_bytes, "application/pdf"))],
            {"target": "pdf"},
            "'fake.docx' does not look like a docx file.",
        ),
    ]
    for files, data, detail in cases:
        response = client.post("/pdf/convert", files=files, data=data)
        assert response.status_code == 400, (files, data)
        assert response.json()["detail"] == detail, (files, data)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && uv run pytest tests/test_submit_endpoints.py -v`
Expected: new tests FAIL with 404; existing pass.

- [ ] **Step 3: Implement**

In `api/app/routers/pdf.py` add (after the rotate endpoint):
```python
# Extension → convert-tool source kind.
_SOURCE_KINDS = {
    ".pdf": "pdf",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".docx": "docx",
    ".md": "md",
    ".markdown": "md",
    ".html": "html",
    ".htm": "html",
    ".txt": "txt",
}

# Binary signatures per kind; text kinds instead reject NUL bytes.
_MAGIC_PREFIXES = {
    "pdf": (b"%PDF",),
    "image": (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff"),
    "docx": (b"PK\x03\x04",),
}

_CONVERT_TARGETS = {"pdf", "docx", "md", "html", "txt", "png", "jpeg"}
_ALLOWED_PAIRS = {
    "pdf": {"png", "jpeg", "docx", "md", "txt"},
    "image": {"pdf"},
    "docx": {"pdf", "md", "html", "txt"},
    "md": {"pdf", "html", "docx", "txt"},
    "html": {"pdf", "md", "docx", "txt"},
    "txt": {"pdf", "md", "html", "docx"},
}
_DPI_PRESETS = {72, 150, 300}


async def _stream_source_to_disk(file: UploadFile, dest: Path, kind: str, name: str) -> None:
    """Write any supported source file to disk with kind-aware validation.

    Binary kinds are checked by magic bytes; text kinds must not contain NUL
    bytes in the first chunk. Size cap and empty check match the PDF validator.
    """
    mismatch = HTTPException(
        status_code=400, detail=f"'{name}' does not look like a {kind} file."
    )
    size = 0
    is_first_chunk = True
    with dest.open("wb") as out:
        while True:
            chunk = await file.read(_CHUNK_SIZE)
            if not chunk:
                break
            if is_first_chunk:
                prefixes = _MAGIC_PREFIXES.get(kind)
                if prefixes is not None:
                    if not any(chunk.startswith(p) for p in prefixes):
                        raise mismatch
                elif b"\x00" in chunk:
                    raise mismatch
                is_first_chunk = False
            size += len(chunk)
            if size > _MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"'{name}' exceeds the {settings.max_upload_mb} MB limit.",
                )
            out.write(chunk)
    if size == 0:
        raise HTTPException(status_code=400, detail=f"'{name}' is empty.")


@router.post(
    "/convert",
    status_code=202,
    summary="Queue a file conversion",
    response_model=JobAccepted,
)
async def convert(
    request: Request,
    files: List[UploadFile] = File(..., description="The file to convert (multiple images may combine into one PDF)."),
    target: str = Form(..., description="Target format: pdf, docx, md, html, txt, png, or jpeg."),
    dpi: int | None = Form(None, description="Resolution for png/jpeg targets: 72, 150, or 300."),
) -> JobAccepted:
    """Validate the upload(s) and conversion pair, then queue a convert job."""
    if target not in _CONVERT_TARGETS:
        raise HTTPException(status_code=400, detail="Invalid target format.")
    if dpi is not None and (target not in ("png", "jpeg") or dpi not in _DPI_PRESETS):
        raise HTTPException(status_code=400, detail="Invalid DPI.")

    names = [_safe_name(f.filename, f"document-{i + 1}") for i, f in enumerate(files)]
    kinds = [_SOURCE_KINDS.get(Path(name).suffix.lower()) for name in names]
    if any(kind is None for kind in kinds):
        raise HTTPException(status_code=400, detail="Unsupported file type.")
    source_kind = kinds[0]
    if len(files) > 1 and not (all(k == "image" for k in kinds) and target == "pdf"):
        raise HTTPException(
            status_code=400,
            detail="Convert takes one file at a time (multiple images can be combined into a PDF).",
        )
    if target not in _ALLOWED_PAIRS[source_kind]:
        raise HTTPException(status_code=400, detail=f"Cannot convert {source_kind} to {target}.")

    work_dir = Path(tempfile.mkdtemp(prefix="chowbea-convert-"))
    try:
        total_bytes = 0
        for index, (file, name, kind) in enumerate(zip(files, names, kinds)):
            input_path = work_dir / f"input-{index}{Path(name).suffix.lower()}"
            await _stream_source_to_disk(file, input_path, kind, name)
            total_bytes += input_path.stat().st_size
    except Exception:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise

    params: dict[str, Any] = {"target": target, "names": names, "source_kind": source_kind}
    if dpi is not None:
        params["dpi"] = dpi
    return await _accept_job(
        request,
        tool="convert",
        workspace=work_dir,
        file_count=len(names),
        total_bytes=total_bytes,
        params=params,
    )
```
Note: mixed-kind multi uploads (e.g. one png + one pdf) fail the all-image check → the one-file 400; that matches the copy.

- [ ] **Step 4: Full suite**

Run: `cd api && uv run pytest`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add api/app/routers/pdf.py api/tests/test_submit_endpoints.py
git commit -m "Add POST /pdf/convert with kind-aware upload validation"
```

---

### Task 5: Web — convert store, api wrapper, page, tile, label

**Files:**
- Create: `web/src/stores/convert.ts`, `web/src/routes/convert.tsx`
- Modify: `web/src/lib/api.ts`, `web/src/routes/index.tsx` (Convert tile → `to: "/convert"`), `web/src/routes/queue.tsx` (`convert: "Convert"`), `web/src/stores/stores.test.ts` (one added test)
- Commit also: `web/src/routeTree.gen.ts`

**Interfaces:**
- Consumes: `runJobFlow`/`submitForm` machinery, `ToolStatus`, established page patterns (merge = ordered multi-file list; compress = option cards).
- Produces: `convertFiles(files: File[], target: ConvertTarget, dpi: number | null, onProgress?) -> Promise<ConvertResult>`.

- [ ] **Step 1: Store + store test**

`web/src/stores/convert.ts`:
```ts
import { create } from "zustand"

import type { CompressionProgress, ConvertResult, ConvertTarget } from "@/lib/api"
import type { ToolStatus } from "./status"

interface ConvertState {
  files: File[]
  target: ConvertTarget | null
  dpi: number
  status: ToolStatus
  result: ConvertResult | null
  error: string | null
  progress: CompressionProgress | null
  reset: () => void
}

const initialState = {
  files: [] as File[],
  target: null as ConvertTarget | null,
  dpi: 150,
  status: "idle" as ToolStatus,
  result: null as ConvertResult | null,
  error: null as string | null,
  progress: null as CompressionProgress | null,
}

/** Module-level store: survives route unmounts, so leaving the page mid-job
loses nothing — in-flight submit callbacks keep writing here. */
export const useConvertStore = create<ConvertState>()((set) => ({
  ...initialState,
  reset: () => set(initialState),
}))
```
Append to `web/src/stores/stores.test.ts`:
```ts
import { useConvertStore } from "./convert"

it("convert store resets target and dpi", () => {
  useConvertStore.setState({ target: "docx", dpi: 300, status: "loading" })
  useConvertStore.getState().reset()
  expect(useConvertStore.getState()).toMatchObject({ target: null, dpi: 150, status: "idle" })
})
```
(Place the import at the top with the others and the test inside the existing `describe` block.)

- [ ] **Step 2: api wrapper in `web/src/lib/api.ts`** (after the rotate section):
```ts
/** Formats the convert tool can produce. */
export const CONVERT_TARGETS = ["pdf", "docx", "md", "html", "txt", "png", "jpeg"] as const

export type ConvertTarget = (typeof CONVERT_TARGETS)[number]

/** Result of a successful convert request. */
export interface ConvertResult {
  /** The converted file (or a ZIP of page images). */
  blob: Blob
  /** Suggested download filename parsed from the response. */
  filename: string
}

/**
 * Convert file(s) to the target format. Multiple files are allowed only when
 * they are images being combined into a single PDF (array order = page order).
 *
 * @throws Error with the API's error detail on failure.
 */
export async function convertFiles(
  files: File[],
  target: ConvertTarget,
  dpi: number | null,
  onProgress?: (progress: CompressionProgress) => void,
): Promise<ConvertResult> {
  const form = new FormData()
  for (const file of files) {
    form.append("files", file)
  }
  form.append("target", target)
  if (dpi !== null) {
    form.append("dpi", String(dpi))
  }
  const download = await runJobFlow({
    tool: "convert",
    submit: () => submitForm("/pdf/convert", form, onProgress),
    onProgress,
  })
  return {
    blob: download.blob,
    filename: download.filename ?? "converted",
  }
}
```

- [ ] **Step 3: Create `web/src/routes/convert.tsx`**

```tsx
import { createFileRoute } from "@tanstack/react-router"
import * as React from "react"
import { motion } from "motion/react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Download04Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons"
// Also import the icon the homepage Convert tile uses (read index.tsx; see
// Step 4 note) and pass it to ToolHeader + the file rows below.

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Dropzone } from "@/components/dropzone"
import { ToolHeader } from "@/components/tool-header"
import { cn } from "@/lib/utils"
import {
  type CompressionProgress,
  type ConvertTarget,
  convertFiles,
  downloadBlob,
  formatBytes,
} from "@/lib/api"
import { useConvertStore } from "@/stores/convert"

export const Route = createFileRoute("/convert")({ component: ConvertPage })

const PHASE_LABELS: Record<CompressionProgress["phase"], string> = {
  uploading: "Uploading",
  queued: "In line",
  processing: "Converting",
  downloading: "Downloading",
}

type SourceKind = "pdf" | "image" | "docx" | "md" | "html" | "txt"

const EXTENSION_KINDS: Record<string, SourceKind> = {
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  docx: "docx",
  md: "md",
  markdown: "md",
  html: "html",
  htm: "html",
  txt: "txt",
}

const KIND_LABELS: Record<SourceKind, string> = {
  pdf: "PDF",
  image: "Image",
  docx: "Word",
  md: "Markdown",
  html: "HTML",
  txt: "Text",
}

const TARGETS_BY_KIND: Record<SourceKind, Array<{ value: ConvertTarget; label: string; hint: string }>> = {
  pdf: [
    { value: "png", label: "PNG images", hint: "Each page as a PNG, zipped" },
    { value: "jpeg", label: "JPEG images", hint: "Each page as a JPEG, zipped" },
    { value: "docx", label: "Word", hint: "Editable .docx — best on text PDFs" },
    { value: "md", label: "Markdown", hint: "Plain text extraction" },
    { value: "txt", label: "Text", hint: "Plain text extraction" },
  ],
  image: [{ value: "pdf", label: "PDF", hint: "Combine images into one PDF, in order" }],
  docx: [
    { value: "pdf", label: "PDF", hint: "High-fidelity via LibreOffice" },
    { value: "md", label: "Markdown", hint: "" },
    { value: "html", label: "HTML", hint: "" },
    { value: "txt", label: "Text", hint: "" },
  ],
  md: [
    { value: "pdf", label: "PDF", hint: "Rendered document" },
    { value: "html", label: "HTML", hint: "" },
    { value: "docx", label: "Word", hint: "" },
    { value: "txt", label: "Text", hint: "" },
  ],
  html: [
    { value: "pdf", label: "PDF", hint: "Rendered page" },
    { value: "md", label: "Markdown", hint: "" },
    { value: "docx", label: "Word", hint: "" },
    { value: "txt", label: "Text", hint: "" },
  ],
  txt: [
    { value: "pdf", label: "PDF", hint: "Monospace document" },
    { value: "md", label: "Markdown", hint: "" },
    { value: "html", label: "HTML", hint: "" },
    { value: "docx", label: "Word", hint: "" },
  ],
}

const DPI_OPTIONS = [
  { value: 72, label: "72 dpi", hint: "Small, for screens" },
  { value: 150, label: "150 dpi", hint: "Balanced" },
  { value: 300, label: "300 dpi", hint: "Print quality" },
]

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,.md,.markdown,.html,.htm,.txt"

function kindOf(file: File): SourceKind | null {
  const ext = file.name.toLowerCase().split(".").pop() ?? ""
  return EXTENSION_KINDS[ext] ?? null
}

function ConvertPage() {
  const { files, target, dpi, status, result, error, progress } = useConvertStore()
  const inputRef = React.useRef<HTMLInputElement>(null)

  const sourceKind = files.length > 0 ? kindOf(files[0]) : null
  const targets = sourceKind ? TARGETS_BY_KIND[sourceKind] : []
  const isImageBatch = sourceKind === "image"
  const loading = status === "loading"

  const addFiles = React.useCallback((incoming: FileList | null) => {
    if (!incoming) return
    const supported = Array.from(incoming).filter((file) => kindOf(file) !== null)
    if (supported.length === 0) return
    useConvertStore.setState((state) => {
      const firstKind = state.files.length > 0 ? kindOf(state.files[0]) : kindOf(supported[0])
      // Images accumulate (they combine into one PDF); anything else replaces.
      if (firstKind !== "image" || supported.some((f) => kindOf(f) !== "image")) {
        const file = supported[0]
        const kind = kindOf(file)!
        return {
          files: [file],
          target: kind === "image" ? ("pdf" as ConvertTarget) : null,
          status: "idle" as const,
          result: null,
          error: null,
        }
      }
      const seen = new Set(state.files.map((f) => `${f.name}:${f.size}`))
      const unique: File[] = []
      for (const file of supported) {
        const key = `${file.name}:${file.size}`
        if (seen.has(key)) continue
        seen.add(key)
        unique.push(file)
      }
      return {
        files: [...state.files, ...unique],
        target: "pdf" as ConvertTarget,
        status: "idle" as const,
        result: null,
        error: null,
      }
    })
  }, [])

  const removeFile = (index: number) => {
    useConvertStore.setState((state) => {
      const files = state.files.filter((_, i) => i !== index)
      return { files, target: files.length === 0 ? null : state.target, status: "idle" as const, result: null }
    })
  }

  const moveFile = (index: number, delta: -1 | 1) => {
    useConvertStore.setState((state) => {
      const to = index + delta
      if (to < 0 || to >= state.files.length) return state
      const next = [...state.files]
      ;[next[index], next[to]] = [next[to], next[index]]
      return { files: next, status: "idle" as const, result: null }
    })
  }

  const handleConvert = async () => {
    const current = useConvertStore.getState()
    if (current.files.length === 0 || !current.target) return
    useConvertStore.setState({
      status: "loading",
      error: null,
      result: null,
      progress: { phase: "uploading", percent: 0 },
    })
    try {
      const converted = await convertFiles(
        current.files,
        current.target,
        current.target === "png" || current.target === "jpeg" ? current.dpi : null,
        (p) => useConvertStore.setState({ progress: p }),
      )
      useConvertStore.setState({ result: converted, status: "success" })
    } catch (err) {
      useConvertStore.setState({
        error: err instanceof Error ? err.message : "Something went wrong.",
        status: "error",
      })
    } finally {
      useConvertStore.setState({ progress: null })
    }
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0)

  return (
    <div className="pb-4">
      <ToolHeader
        icon={/* homepage Convert tile icon — resolve in Step 4 */ Add01Icon}
        title="Convert"
        subtitle="PDF, Word, Markdown, HTML, text, and images — changed into each other."
      />

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(event) => addFiles(event.target.files)}
      />

      <div className="mt-8 grid grid-cols-1 items-start gap-7 lg:grid-cols-[1fr_360px]">
        {/* ── Left: file(s) ── */}
        {files.length === 0 ? (
          <Dropzone
            multiple
            onFiles={addFiles}
            onPick={() => inputRef.current?.click()}
            title="Drop a file here"
            hint="PDF, Word, Markdown, HTML, text, or images"
          />
        ) : (
          <div className="rounded-[20px] border-2 border-ink bg-card p-[22px] shadow-block-lg">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-[13px] font-extrabold uppercase tracking-wide text-muted-ink">
                {KIND_LABELS[sourceKind!]} · {files.length} file{files.length > 1 ? "s" : ""}
                {isImageBatch && files.length > 1 ? " — combined top to bottom" : ""}
              </span>
              <span className="text-[13px] font-bold text-muted-ink">{formatBytes(totalSize)}</span>
            </div>

            <div className="flex flex-col gap-2.5">
              {files.map((file, index) => (
                <div
                  key={`${file.name}:${file.size}`}
                  className="flex items-center gap-3 rounded-[14px] border-2 border-ink bg-surface px-3 py-2.5"
                >
                  {isImageBatch && (
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] border-2 border-ink bg-soft-amber font-heading text-[15px] font-extrabold text-ink">
                      {index + 1}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-heading text-[15px] font-extrabold text-ink">
                      {file.name}
                    </div>
                    <div className="text-[13px] font-semibold text-muted-ink">
                      {formatBytes(file.size)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {isImageBatch && (
                      <>
                        <button
                          type="button"
                          aria-label={`Move ${file.name} up`}
                          disabled={index === 0 || loading}
                          onClick={() => moveFile(index, -1)}
                          className="press flex size-8 items-center justify-center rounded-[9px] border-2 border-ink text-ink disabled:opacity-30"
                        >
                          <HugeiconsIcon icon={ArrowUp01Icon} className="size-4" strokeWidth={2.4} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${file.name} down`}
                          disabled={index === files.length - 1 || loading}
                          onClick={() => moveFile(index, 1)}
                          className="press flex size-8 items-center justify-center rounded-[9px] border-2 border-ink text-ink disabled:opacity-30"
                        >
                          <HugeiconsIcon icon={ArrowDown01Icon} className="size-4" strokeWidth={2.4} />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      disabled={loading}
                      onClick={() => removeFile(index)}
                      className="press flex size-8 items-center justify-center rounded-[9px] border-2 border-ink text-ink disabled:opacity-30"
                    >
                      <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={2.4} />
                    </button>
                  </div>
                </div>
              ))}

              {isImageBatch && (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => inputRef.current?.click()}
                  className="flex items-center justify-center gap-2 rounded-[14px] border-2 border-dashed border-[#c9b89c] py-3 text-[13px] font-extrabold uppercase tracking-wide text-muted-ink transition-colors hover:border-ink hover:text-ink disabled:opacity-30"
                >
                  <HugeiconsIcon icon={Add01Icon} className="size-4" strokeWidth={2.4} />
                  Add more images
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Right: target picker — sticky on desktop so it stays in view ── */}
        <div className="rounded-[20px] border-2 border-ink bg-card p-6 shadow-block-lg sm:p-8 lg:sticky lg:top-7">
          <div className="mb-3.5 text-[13px] font-extrabold uppercase tracking-wide text-ink">
            Convert to
          </div>
          {targets.length === 0 ? (
            <p className="text-[14px] font-semibold text-muted-ink">
              Drop a file to see what it can become.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {targets.map((option) => {
                const selected = target === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={loading}
                    onClick={() => useConvertStore.setState({ target: option.value, status: "idle", result: null })}
                    className={cn(
                      "flex items-center gap-3.5 rounded-[14px] border-2 border-ink p-4 text-left transition-[background-color,box-shadow]",
                      selected ? "bg-surface shadow-amber-sm" : "bg-card hover:bg-surface",
                      "disabled:opacity-60",
                    )}
                  >
                    <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full border-2 border-ink">
                      {selected && <span className="size-2.5 rounded-full bg-amber" />}
                    </span>
                    <span className="flex-1">
                      <span className="block font-heading text-[17px] font-extrabold text-ink">
                        {option.label}
                      </span>
                      {option.hint && (
                        <span className="block text-[13px] font-semibold text-[#6b5f50]">
                          {option.hint}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {(target === "png" || target === "jpeg") && (
            <>
              <div className="mb-3.5 mt-6 text-[13px] font-extrabold uppercase tracking-wide text-ink">
                Resolution
              </div>
              <div className="flex gap-2.5">
                {DPI_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={loading}
                    onClick={() => useConvertStore.setState({ dpi: option.value })}
                    className={cn(
                      "flex-1 rounded-[12px] border-2 border-ink px-3 py-2.5 text-center",
                      dpi === option.value ? "bg-amber" : "bg-card hover:bg-surface",
                      "disabled:opacity-60",
                    )}
                  >
                    <span className="block font-heading text-[15px] font-extrabold text-ink">
                      {option.label}
                    </span>
                    <span className="block text-[12px] font-semibold text-[#6b5f50]">
                      {option.hint}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          <Button
            size="lg"
            onClick={handleConvert}
            disabled={files.length === 0 || !target || loading}
            className="mt-6 w-full"
          >
            {loading ? (
              <>
                <HugeiconsIcon icon={Loading03Icon} className="animate-spin" />
                Converting…
              </>
            ) : (
              "Convert"
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
              <div className="truncate font-heading text-lg font-extrabold text-ink">
                {result.filename}
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

- [ ] **Step 4: Resolve the icon, flip the tile, add the label**

Read `web/src/routes/index.tsx`, note the Convert tile's icon, import it in `convert.tsx` for the `ToolHeader` (replacing the `Add01Icon` placeholder and its comment — verify the name exists in `web/node_modules/@hugeicons/core-free-icons/dist/types/index.d.ts`). Give the Convert tile `to: "/convert"`. Add `convert: "Convert"` to `TOOL_LABELS` in `web/src/routes/queue.tsx`.

- [ ] **Step 5: Gates**

Run: `cd web && bun run test && bun run typecheck && bun run build`
Expected: vitest 12 passed (11 + 1 store test); typecheck clean; build green with `/convert` in `routeTree.gen.ts`.

- [ ] **Step 6: Commit**

```bash
git add web/src/stores/convert.ts web/src/stores/stores.test.ts web/src/lib/api.ts web/src/routes/convert.tsx web/src/routes/index.tsx web/src/routes/queue.tsx web/src/routeTree.gen.ts
git commit -m "Add convert tool page with kind-aware target picker"
```

---

### Task 6 (controller): Codegen

- [ ] Start a throwaway uvicorn on an unused high port (e.g. 8055 — port 8000 may be occupied by the owner's other projects), point `web/api.config.toml` at it temporarily, `bun api:fetch --force && bun api:generate`, revert the config, typecheck, commit `web/src/services/api/` as "Regenerate typed API client for the convert endpoint", kill uvicorn. No other servers; no browsers.

### Task 7 (controller): Final review, PR, prod verify

- [ ] Whole-branch review (most capable model) with accumulated Minors for triage; fix wave if needed.
- [ ] Push, PR, wait for `api`+`web` checks (CI now installs engines — the api job will take longer), merge, pull main.
- [ ] Prod verification (curl only): expect a LONG first api build (image +500–600 MB). Then: `/health` commit matches; submit md→pdf (upload a small .md, poll, download starts `%PDF`); submit pdf→png (generated 2-page pdf, poll, download starts `PK`, unzip lists `page-1.png page-2.png`); `https://pdf.chowbea.com/convert` returns 200.
