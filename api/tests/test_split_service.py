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
