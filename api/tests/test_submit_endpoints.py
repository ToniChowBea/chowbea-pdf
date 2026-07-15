"""Submit endpoints return 202 + a queued job instead of processing inline."""

import json

from app.jobs.registry import JobStatus


def test_compress_returns_202_with_position(client, registry, fake_queue, pdf_bytes):
    response = client.post(
        "/pdf/compress",
        files=[("files", ("a.pdf", pdf_bytes, "application/pdf"))],
        data={"quality": "ebook"},
    )
    assert response.status_code == 202
    body = response.json()
    record = registry.get(body["job_id"])
    assert record is not None
    assert record.tool == "compress"
    assert record.status is JobStatus.queued
    assert record.params["quality"] == "ebook"
    assert record.params["names"] == ["a.pdf"]
    assert (record.workspace / "input-0.pdf").exists()
    assert body["position"] == 1
    assert body["queue_size"] == 1
    assert fake_queue.published == [body["job_id"]]


def test_lock_stores_params_and_input(client, registry, pdf_bytes):
    response = client.post(
        "/pdf/lock",
        files={"file": ("b.pdf", pdf_bytes, "application/pdf")},
        data={"password": "pw", "encryption": "aes-256"},
    )
    assert response.status_code == 202
    record = registry.get(response.json()["job_id"])
    assert record.tool == "lock"
    assert record.params["password"] == "pw"
    assert record.params["name"] == "b.pdf"
    assert (record.workspace / "input.pdf").exists()


def test_unlock_requires_valid_pdf(client):
    response = client.post(
        "/pdf/unlock",
        files={"file": ("evil.pdf", b"not a pdf", "application/pdf")},
        data={"password": "pw"},
    )
    assert response.status_code == 400


def test_queue_down_returns_503_and_cleans_up(client, registry, fake_queue, pdf_bytes):
    fake_queue.ready = False
    response = client.post(
        "/pdf/unlock",
        files={"file": ("a.pdf", pdf_bytes, "application/pdf")},
        data={"password": "pw"},
    )
    assert response.status_code == 503
    assert registry.queue_size() == 0


def test_unexpected_publish_error_returns_503_and_cleans_up(
    client, registry, fake_queue, pdf_bytes
):
    async def _boom(job_id):
        raise RuntimeError("boom")

    fake_queue.publish = _boom
    response = client.post(
        "/pdf/unlock",
        files={"file": ("a.pdf", pdf_bytes, "application/pdf")},
        data={"password": "pw"},
    )
    assert response.status_code == 503
    assert registry.queue_size() == 0


def test_merge_returns_202_with_ordered_names(client, registry, fake_queue, pdf_bytes):
    response = client.post(
        "/pdf/merge",
        files=[
            ("files", ("b.pdf", pdf_bytes, "application/pdf")),
            ("files", ("a.pdf", pdf_bytes, "application/pdf")),
        ],
    )
    assert response.status_code == 202
    body = response.json()
    record = registry.get(body["job_id"])
    assert record.tool == "merge"
    assert record.params["names"] == ["b.pdf", "a.pdf"]
    assert (record.workspace / "input-0.pdf").exists()
    assert (record.workspace / "input-1.pdf").exists()
    assert fake_queue.published == [body["job_id"]]


def test_merge_requires_two_files(client, pdf_bytes):
    response = client.post(
        "/pdf/merge",
        files=[("files", ("a.pdf", pdf_bytes, "application/pdf"))],
    )
    assert response.status_code == 400
    assert "at least two" in response.json()["detail"]


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
        ('[{"index": 0, "rotation": 90.0}]', "Invalid page list."),
        ("[" * 20000 + "]" * 20000, "Invalid page list."),
    ]:
        response = client.post(
            "/pdf/rotate",
            files={"file": ("doc.pdf", pdf_bytes, "application/pdf")},
            data={"pages": raw},
        )
        assert response.status_code == 400, raw
        assert response.json()["detail"] == expected_detail, raw


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


def test_convert_rejects_zip_masquerading_as_docx(client):
    import io
    import zipfile as zipfile_module

    buffer = io.BytesIO()
    with zipfile_module.ZipFile(buffer, "w") as archive:
        archive.writestr("not-word.txt", "hello")
    response = client.post(
        "/pdf/convert",
        files=[("files", ("fake.docx", buffer.getvalue(), "application/octet-stream"))],
        data={"target": "pdf"},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "'fake.docx' does not look like a docx file."


def test_convert_accepts_minimal_real_docx_container(client, registry):
    import io
    import zipfile as zipfile_module

    buffer = io.BytesIO()
    with zipfile_module.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", "<w:document/>")
    response = client.post(
        "/pdf/convert",
        files=[("files", ("real.docx", buffer.getvalue(), "application/octet-stream"))],
        data={"target": "txt"},
    )
    assert response.status_code == 202


def test_convert_rejects_late_nul_bytes_in_text(client):
    payload = b"a" * (1024 * 1024 + 10) + b"\x00binary"
    response = client.post(
        "/pdf/convert",
        files=[("files", ("notes.txt", payload, "text/plain"))],
        data={"target": "pdf"},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "'notes.txt' does not look like a txt file."


def test_convert_rejects_docx_with_absurd_entry_count(client):
    fake = b"PK\x03\x04" + b"\x00" * 32 + b"PK\x05\x06" + b"\x00" * 4 + (60000).to_bytes(2, "little") * 2 + b"\x00" * 10
    response = client.post(
        "/pdf/convert",
        files=[("files", ("bomb.docx", fake, "application/octet-stream"))],
        data={"target": "pdf"},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "'bomb.docx' does not look like a docx file."


def test_allowed_pairs_match_service_registry():
    from app.routers.pdf import _ALLOWED_PAIRS
    from app.services.convert import _CONVERTERS

    router_pairs = {(kind, target) for kind, targets in _ALLOWED_PAIRS.items() for target in targets}
    assert router_pairs == set(_CONVERTERS)
