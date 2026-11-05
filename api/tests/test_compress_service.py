"""PDF compression via Ghostscript.

Engine-dependent tests skip when `gs` is missing locally; CI installs
Ghostscript, so those paths run there.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from unittest.mock import patch

import pikepdf
import pytest

from app.services.compress import (
    CompressionError,
    CompressionQuality,
    CompressionStats,
    GhostscriptNotInstalledError,
    _ghostscript_binary,
    compress_pdf_file,
)

needs_gs = pytest.mark.skipif(
    shutil.which("gs") is None, reason="Ghostscript not installed"
)


def make_pdf(path: Path, pages: int = 1) -> None:
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page()
    pdf.save(path)
    pdf.close()


def test_ratio_is_fraction_of_original_removed() -> None:
    assert CompressionStats(100, 40).ratio == pytest.approx(0.6)
    assert CompressionStats(100, 100).ratio == 0.0
    assert CompressionStats(0, 0).ratio == 0.0


def test_ghostscript_missing_raises_clear_error() -> None:
    with patch("app.services.compress.shutil.which", return_value=None):
        with pytest.raises(GhostscriptNotInstalledError, match="Ghostscript"):
            _ghostscript_binary()


@needs_gs
def test_compress_writes_valid_pdf_and_never_inflates(tmp_path: Path) -> None:
    src = tmp_path / "in.pdf"
    out = tmp_path / "out.pdf"
    make_pdf(src, pages=2)

    stats = compress_pdf_file(src, out, CompressionQuality.screen)

    assert out.exists()
    assert out.read_bytes()[:4] == b"%PDF"
    assert stats.original_size == src.stat().st_size
    assert stats.compressed_size == out.stat().st_size
    assert stats.compressed_size <= stats.original_size
    with pikepdf.open(out) as result:
        assert len(result.pages) == 2


@needs_gs
def test_compress_passes_quality_preset_to_ghostscript(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = tmp_path / "in.pdf"
    out = tmp_path / "out.pdf"
    make_pdf(src)
    captured: list[list[str]] = []

    real_run = subprocess.run

    def spy_run(command, *args, **kwargs):  # noqa: ANN001
        captured.append(list(command))
        return real_run(command, *args, **kwargs)

    monkeypatch.setattr("app.services.compress.subprocess.run", spy_run)
    compress_pdf_file(src, out, CompressionQuality.printer)

    assert captured, "Ghostscript was not invoked"
    assert "-dPDFSETTINGS=/printer" in captured[0]
    assert f"-sOutputFile={out}" in captured[0]


@needs_gs
def test_compress_keeps_original_when_ghostscript_inflates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Already-optimized PDFs must not grow; restore the original bytes."""
    src = tmp_path / "in.pdf"
    out = tmp_path / "out.pdf"
    make_pdf(src)
    original = src.read_bytes()

    def fake_run(command, check, capture_output):  # noqa: ANN001, ARG001
        for arg in command:
            if arg.startswith("-sOutputFile="):
                Path(arg.removeprefix("-sOutputFile=")).write_bytes(
                    original + b"\0" * 256
                )
                return subprocess.CompletedProcess(command, 0, b"", b"")
        raise AssertionError("Ghostscript command had no -sOutputFile")

    monkeypatch.setattr("app.services.compress.subprocess.run", fake_run)
    stats = compress_pdf_file(src, out, CompressionQuality.ebook)

    assert out.read_bytes() == original
    assert stats.compressed_size == stats.original_size
    assert stats.ratio == 0.0


@needs_gs
def test_compress_raises_on_garbage_input(tmp_path: Path) -> None:
    src = tmp_path / "junk.pdf"
    out = tmp_path / "out.pdf"
    src.write_bytes(b"%PDF-not really a pdf")
    with pytest.raises(CompressionError, match="Ghostscript failed"):
        compress_pdf_file(src, out, CompressionQuality.ebook)


@needs_gs
def test_compress_wraps_ghostscript_stderr(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = tmp_path / "in.pdf"
    out = tmp_path / "out.pdf"
    make_pdf(src)

    def failing_run(command, check, capture_output):  # noqa: ANN001, ARG001
        raise subprocess.CalledProcessError(
            1, command, output=b"", stderr=b"Error: /undefined in junk"
        )

    monkeypatch.setattr("app.services.compress.subprocess.run", failing_run)
    with pytest.raises(CompressionError, match="undefined in junk"):
        compress_pdf_file(src, out, CompressionQuality.screen)