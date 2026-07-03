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


_MIN_PDF_UNITS = 3.0  # img2pdf/pikepdf reject pages smaller than this on a side.


def _clamped_layout_fun(imgwidthpx, imgheightpx, ndpi):
    """img2pdf's default layout, floored so tiny source images (icons, 1x1
    test fixtures) still produce a page pikepdf accepts (min 3 PDF units)."""
    import img2pdf

    pagewidth, pageheight, imgwidthpdf, imgheightpdf = img2pdf.default_layout_fun(
        imgwidthpx, imgheightpx, ndpi
    )
    if pagewidth < _MIN_PDF_UNITS or pageheight < _MIN_PDF_UNITS:
        scale = max(_MIN_PDF_UNITS / pagewidth, _MIN_PDF_UNITS / pageheight)
        pagewidth *= scale
        pageheight *= scale
        imgwidthpdf *= scale
        imgheightpdf *= scale
    return pagewidth, pageheight, imgwidthpdf, imgheightpdf


def _images_to_pdf(workspace: Path, names: list[str], output: Path, dpi: int) -> None:
    import img2pdf

    paths = [str(p) for p in _input_paths(workspace, names)]
    try:
        output.write_bytes(img2pdf.convert(paths, layout_fun=_clamped_layout_fun))
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
        _run(
            [pandoc, str(input_path), "-f", reader, "-t", writer, "--sandbox", "-o", str(output)],
            name,
        )
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


def _data_only_url_fetcher(url: str):
    """WeasyPrint fetcher that only honors inline data: URIs.

    User-supplied documents must never trigger server-side fetches: file://
    reads local files and http(s) reaches internal networks (SSRF).
    """
    if url.startswith("data:"):
        from weasyprint import default_url_fetcher

        return default_url_fetcher(url)
    raise ValueError("External resources are not fetched during conversion.")


def _html_file_to_pdf(html_path: Path, output: Path, name: str) -> None:
    try:
        from weasyprint import HTML
    except Exception as exc:  # noqa: BLE001 - missing system libs land here
        raise ConvertError(f"'{name}' could not be converted (engine unavailable).") from exc

    try:
        HTML(filename=str(html_path), url_fetcher=_data_only_url_fetcher).write_pdf(str(output))
    except Exception as exc:  # noqa: BLE001
        raise ConvertError(f"'{name}' could not be converted.") from exc


def _html_to_pdf(workspace: Path, names: list[str], output: Path, dpi: int) -> None:
    _html_file_to_pdf(_input_paths(workspace, names)[0], output, names[0])


def _md_to_pdf(workspace: Path, names: list[str], output: Path, dpi: int) -> None:
    name = names[0]
    pandoc = _require("pandoc", name)
    input_path = _input_paths(workspace, names)[0]
    intermediate = workspace / "intermediate.html"
    _run(
        [pandoc, str(input_path), "-f", "markdown", "-t", "html", "-s", "--sandbox", "-o", str(intermediate)],
        name,
    )
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
