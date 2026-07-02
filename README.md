# Chowbea PDF

Free, ad-free PDF tools — live at **[pdf.chowbea.com](https://pdf.chowbea.com)**.

Upload a PDF, pick a tool, get your file back. No accounts, no clutter.

## Tools

- **Compress** — shrink one or more PDFs through Ghostscript presets (72–300 dpi)
- **Lock** — password-protect a PDF (AES-128/256, printing/copying/editing permissions)
- **Unlock** — remove a password you know

Every job runs through a RabbitMQ-backed queue (three at a time, so heavy load
never takes the service down) with a public **[/queue](https://pdf.chowbea.com/queue)**
board showing what's processing and who's in line. Results are kept for
30 minutes, then swept.

## Architecture

```
┌──────────────┐  submit (202 + job id)  ┌──────────────┐   publish   ┌──────────┐
│ web          │ ───────────────────────▶│ api          │ ───────────▶│ RabbitMQ │
│ TanStack     │  poll /jobs/{id}        │ FastAPI      │◀─────────── │ pdf-jobs │
│ Start + bun  │◀─────────────────────── │ + worker     │  consume ×3 └──────────┘
└──────────────┘  download when done     │ (Ghostscript,│
                                         │  pikepdf)    │
                                         └──────────────┘
```

- `web/` — TanStack Start frontend (React 19, Vite, Tailwind, shadcn, hugeicons) on bun
- `api/` — FastAPI backend; the queue consumer runs inside the api process and
  executes jobs on worker threads. Files and passwords never transit the
  broker — messages carry only a job id.
- Deployed on Railway; merges to `main` auto-deploy the service whose files
  changed (once CI passes).

See [purpose.md](purpose.md) for the project goal and roadmap.

## Running locally

Prerequisites:

- [bun](https://bun.sh) >= 1.3
- [uv](https://docs.astral.sh/uv/) (manages Python and dependencies for the API)
- [Ghostscript](https://www.ghostscript.com/) (`gs`) for compression
  - macOS: `brew install ghostscript`
  - Debian/Ubuntu: `apt-get install ghostscript`
  - (Already installed inside the API Docker image.)
- Docker (for the local RabbitMQ broker)

From the repo root:

```bash
make install   # install API (uv) and web (bun) dependencies
make rabbit    # start the local RabbitMQ container (management UI on :15672)
make dev       # run the API and web app together (Ctrl-C stops both)
```

- Web: http://localhost:3000
- API docs: http://localhost:8000/docs · OpenAPI: http://localhost:8000/openapi.json

Other targets: `make api`, `make web`, and `make codegen` (watch the API spec
and regenerate the typed client). Run `make help` to list them.

### Run the apps individually

```bash
# Backend
cd api
uv sync
uv run uvicorn app.main:app --reload --port 8000

# Frontend
cd web
bun install
bun run dev
```

To regenerate the typed API client from the running backend: `bun api:generate`
(one-off) or `bun api:watch` (regenerate on change).

## Tests

```bash
cd api && uv run pytest                      # backend suite
cd web && bun run test && bun run typecheck  # frontend suite + types
```

CI runs both suites on every push and pull request; merges to `main` deploy
automatically once checks pass.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) to get
started, and open an issue first for anything bigger than a small fix.

## License

[MIT](LICENSE)
