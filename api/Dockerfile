# Slim Python base with the uv binary copied in from the official image.
FROM python:3.12-slim

# Bring in uv (and uvx) without a separate install step.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Ghostscript (`gs`) powers compression and PDF→image conversion; pandoc,
# LibreOffice, and weasyprint's pango/cairo libs power the convert tool.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ghostscript \
        libreoffice-writer \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libgdk-pixbuf-2.0-0 \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Official pandoc release: built with embedded data files, so `--sandbox`
# (which blocks filesystem data-dir reads) still lets the docx writer work.
ADD https://github.com/jgm/pandoc/releases/download/3.6.3/pandoc-3.6.3-1-amd64.deb /tmp/pandoc.deb
RUN dpkg -i /tmp/pandoc.deb && rm /tmp/pandoc.deb

WORKDIR /app

# Use the image's system Python, compile bytecode, and copy (not symlink) packages.
ENV UV_PYTHON_DOWNLOADS=0 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

# Install dependencies in their own cached layer, before app code, for fast rebuilds.
# Railway's builder requires cache mounts to carry an id of the form s/<service-id>-<path>
# and supports no other mount types, so the lockfiles are COPYed rather than bind-mounted.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,id=s/a538c712-47e4-4697-9941-e7efa7952728-/root/.cache/uv,target=/root/.cache/uv \
    uv sync --locked

COPY app ./app

# Put the project's virtualenv on PATH so `uvicorn` runs directly.
ENV PATH="/app/.venv/bin:$PATH"
ENV PORT=8000
EXPOSE 8000

# Bind to all interfaces so the container is reachable by the platform router.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
