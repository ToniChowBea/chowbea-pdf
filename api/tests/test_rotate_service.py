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


def test_garbage_input_is_rejected(tmp_path):
    src = tmp_path / "junk.pdf"
    out = tmp_path / "out.pdf"
    src.write_bytes(b"%PDF-not really a pdf")
    with pytest.raises(RotateError, match="'junk.pdf' could not be read"):
        rearrange_pdf_file(src, "junk.pdf", out, [{"index": 0, "rotation": 0}])
