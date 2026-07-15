# Purpose

Chowbea PDF is a small monorepo that provides a web tool for performing actions on
batches of PDF files. The goal is to make common PDF operations fast, private, and
pleasant to use through a modern web UI backed by a focused Python API.

## Architecture

- `web/` — TanStack Start (React 19, Vite, Tailwind v4, shadcn, hugeicons), run on bun.
  Talks to the API through a typed Axios client generated from the API's OpenAPI spec
  by `chowbea-axios`.
- `api/` — Python FastAPI backend. Accepts a list of PDF files and performs an action
  on them. Each action is its own endpoint + service module so new actions can be
  added without disturbing existing ones.

## Actions

Implemented:

- **Compress** — reduce PDF file size using Ghostscript, with selectable quality.
- **Unlock** — remove a known password from a PDF using pikepdf.
- **Split** — break a PDF into page groups (extract, consecutive parts, or every N pages) using pikepdf.

Planned (future):

- Merge, split, watermark, OCR, protect (add password) and similar operations.

## Principles

- Keep it simple. One repo, two independently deployable apps.
- Each new PDF action = one new API endpoint + service module + UI panel.
- Both apps ship with their own Dockerfile for clean, independent hosting.
