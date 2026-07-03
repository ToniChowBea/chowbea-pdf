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
