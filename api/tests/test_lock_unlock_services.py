"""Locking (encrypting) and unlocking (decrypting) PDFs with pikepdf."""

import secrets

import pikepdf
import pytest

from app.services.lock import (
    AlreadyProtectedError,
    EncryptionLevel,
    LockError,
    lock_pdf_file,
)
from app.services.unlock import (
    IncorrectPasswordError,
    NotEncryptedError,
    UnlockError,
    unlock_pdf_file,
)


def random_password():
    # Generated per test so no password-like literals live in the repo.
    return secrets.token_urlsafe(12)


def make_pdf(path, pages=2):
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page()
    pdf.save(path)
    pdf.close()


# --- lock -------------------------------------------------------------------


@pytest.mark.parametrize("level", list(EncryptionLevel))
def test_lock_requires_password_to_open(tmp_path, level):
    src = tmp_path / "in.pdf"
    out = tmp_path / "locked.pdf"
    make_pdf(src, pages=2)
    password = random_password()
    lock_pdf_file(src, out, password, encryption=level)

    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(out)
    with pikepdf.open(out, password=password) as result:
        assert result.is_encrypted
        assert len(result.pages) == 2


def test_lock_applies_permission_flags(tmp_path):
    src = tmp_path / "in.pdf"
    out = tmp_path / "locked.pdf"
    make_pdf(src)
    password = random_password()
    lock_pdf_file(
        src, out, password, allow_printing=False, allow_copying=True, allow_editing=False
    )
    with pikepdf.open(out, password=password) as result:
        allow = result.allow
        assert allow.print_highres is False
        assert allow.extract is True
        assert allow.modify_other is False


def test_lock_rejects_empty_password(tmp_path):
    src = tmp_path / "in.pdf"
    make_pdf(src)
    with pytest.raises(LockError, match="password is required"):
        lock_pdf_file(src, tmp_path / "out.pdf", "")


def test_lock_rejects_already_protected_pdf(tmp_path):
    src = tmp_path / "in.pdf"
    locked = tmp_path / "locked.pdf"
    make_pdf(src)
    lock_pdf_file(src, locked, random_password())
    with pytest.raises(AlreadyProtectedError, match="already password protected"):
        lock_pdf_file(locked, tmp_path / "again.pdf", random_password())


def test_lock_rejects_garbage_input(tmp_path):
    src = tmp_path / "junk.pdf"
    src.write_bytes(b"%PDF-not really a pdf")
    with pytest.raises(LockError, match="Could not lock the PDF"):
        lock_pdf_file(src, tmp_path / "out.pdf", random_password())


# --- unlock -----------------------------------------------------------------


def test_unlock_round_trips_a_locked_pdf(tmp_path):
    src = tmp_path / "in.pdf"
    locked = tmp_path / "locked.pdf"
    out = tmp_path / "unlocked.pdf"
    make_pdf(src, pages=3)
    password = random_password()
    lock_pdf_file(src, locked, password)

    unlock_pdf_file(locked, out, password)
    with pikepdf.open(out) as result:
        assert not result.is_encrypted
        assert len(result.pages) == 3


def test_unlock_wrong_password(tmp_path):
    src = tmp_path / "in.pdf"
    locked = tmp_path / "locked.pdf"
    make_pdf(src)
    lock_pdf_file(src, locked, random_password())
    with pytest.raises(IncorrectPasswordError):
        unlock_pdf_file(locked, tmp_path / "out.pdf", random_password())


def test_unlock_strips_owner_only_encryption_without_password(tmp_path):
    src = tmp_path / "owner_only.pdf"
    out = tmp_path / "out.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page()
    pdf.save(src, encryption=pikepdf.Encryption(owner=random_password(), user="", R=6))
    pdf.close()

    unlock_pdf_file(src, out, "")
    with pikepdf.open(out) as result:
        assert not result.is_encrypted


def test_unlock_rejects_unencrypted_pdf(tmp_path):
    src = tmp_path / "plain.pdf"
    make_pdf(src)
    with pytest.raises(NotEncryptedError):
        unlock_pdf_file(src, tmp_path / "out.pdf", random_password())


def test_unlock_rejects_garbage_input(tmp_path):
    src = tmp_path / "junk.pdf"
    src.write_bytes(b"%PDF-not really a pdf")
    with pytest.raises(UnlockError, match="Could not open the PDF"):
        unlock_pdf_file(src, tmp_path / "out.pdf", random_password())
