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
