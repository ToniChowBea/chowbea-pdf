# Contributing to Chowbea PDF

Thanks for wanting to help! This is a small project with a simple flow.

## Before you start

- **Bugs and small fixes:** open a pull request directly, or file a bug first
  if you want to discuss.
- **Features or anything sizeable:** please open an issue first so we can
  agree on the approach before you invest time.

## Local setup

You need [bun](https://bun.sh) >= 1.3, [uv](https://docs.astral.sh/uv/),
[Ghostscript](https://www.ghostscript.com/) (`gs`), and Docker (for the local
RabbitMQ broker).

```bash
make install   # api (uv) + web (bun) dependencies
make rabbit    # local RabbitMQ container
make dev       # api on :8000, web on :3000
```

## Running the tests

Both suites must pass before a PR can merge — CI enforces this.

```bash
cd api && uv run pytest
cd web && bun run test && bun run typecheck
```

If you touch API endpoints, regenerate the typed client afterwards with the
api running: `cd web && bun api:fetch && bun api:generate`.

## Pull request flow

1. Fork, create a feature branch from `main`.
2. Make your change — one focused change per PR.
3. Run both test suites locally.
4. Open a PR against `main`. The `api` and `web` CI checks must pass.

Direct pushes to `main` are blocked for everyone, including maintainers.
Merges to `main` auto-deploy to production, which is also why:

- **CI holds no secrets** — workflows only run tests, so PRs from forks are
  safe and never touch production.
- Your PR affects nothing live until a maintainer merges it.

## Commit messages

Short imperative subject lines, matching the existing history — e.g.
"Add queue board page", "Fix compress ZIP filenames". No enforced convention
beyond that.

## Code style

Match the surrounding code. The api follows standard FastAPI/pydantic
patterns with docstrings on public functions; the web app uses the existing
Tailwind utility classes and component patterns. Don't reformat code you
aren't changing.

## Questions

Open an issue, or reach the maintainer at platforms@chowbea.com.
