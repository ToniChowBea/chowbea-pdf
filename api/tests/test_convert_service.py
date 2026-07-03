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

from app.services.convert import ConvertError, _data_only_url_fetcher, convert_files

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
def test_md_to_docx_does_not_embed_local_files(tmp_path):
    names = write_inputs(
        tmp_path, [("notes.md", b"# Doc\n\n![leak](/etc/hosts)\n\nText.")]
    )
    result_path, _, _ = convert_files(tmp_path, names, "md", "docx")
    with zipfile.ZipFile(result_path) as archive:
        media = [n for n in archive.namelist() if n.startswith("word/media/")]
        assert media == []  # the referenced local file must NOT be embedded


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


def test_url_fetcher_blocks_everything_but_data_uris():
    for url in ("file:///etc/passwd", "http://127.0.0.1/x", "https://example.com/a.png", "ftp://x/y"):
        with pytest.raises(ValueError):
            _data_only_url_fetcher(url)


def test_url_fetcher_allows_data_uris():
    pytest.importorskip("weasyprint")
    result = _data_only_url_fetcher("data:text/plain;base64,aGk=")
    # weasyprint==69.0's default_url_fetcher returns a URLFetcherResponse
    # (older versions returned a dict with a "string" key); read() is the
    # stable way to get the decoded payload back either way.
    try:
        body = result.read()
    finally:
        result.close()
    assert body == b"hi"


def test_html_to_pdf_does_not_fetch_external_resources(tmp_path):
    pytest.importorskip("weasyprint")
    html = (
        b"<html><body><h1>Doc</h1>"
        b"<img src='file:///etc/hosts'>"
        b"<img src='http://127.0.0.1:1/x.png'>"
        b"</body></html>"
    )
    names = write_inputs(tmp_path, [("page.html", html)])
    result_path, download_name, _ = convert_files(tmp_path, names, "html", "pdf")
    assert download_name == "page.pdf"
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
