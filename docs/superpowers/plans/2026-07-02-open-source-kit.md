# Open Source Contribution Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make oddFEELING/chowbea-pdf ready for outside contributors: MIT license, community docs, issue/PR templates, branch protection gating prod deploys on CI, and deploy→commit traceability.

**Architecture:** Repo settings go on first (so the kit itself lands as the first protected PR, proving the flow). All files land in one branch/PR. One small api change surfaces Railway's injected commit SHA in `/health` and the OpenAPI version.

**Tech Stack:** GitHub CLI (`gh api`, `gh pr`), Markdown/YAML community files, pydantic-settings.

**Spec:** `docs/superpowers/specs/2026-07-02-open-source-kit-design.md`

## Global Constraints

- License: MIT, exact line `Copyright (c) 2026 Emmanuel Alawode`
- Contact for CoC + security: `platforms@chowbea.com`
- Branch protection: required checks exactly `api` and `web` (strict=false), `enforce_admins: true`, `required_approving_review_count: 0`, no force pushes/deletions
- Commit SHA env var: `RAILWAY_GIT_COMMIT_SHA`, settings default `"dev"`; `/health` shows first 7 chars
- Repo description: `Free, ad-free PDF tools — compress, lock, unlock. FastAPI + RabbitMQ job queue, TanStack Start frontend.` Topics: `pdf`, `fastapi`, `rabbitmq`, `tanstack-start`, `self-hosted`
- No CHANGELOG/SemVer/release tooling (out of scope per spec)

---

### Task 1: Repo settings + branch protection

**Files:** none (GitHub settings via gh)

- [ ] **Step 1: Apply description, topics, private vulnerability reporting**

```bash
gh repo edit oddFEELING/chowbea-pdf \
  --description "Free, ad-free PDF tools — compress, lock, unlock. FastAPI + RabbitMQ job queue, TanStack Start frontend." \
  --add-topic pdf --add-topic fastapi --add-topic rabbitmq --add-topic tanstack-start --add-topic self-hosted
gh api -X PUT repos/oddFEELING/chowbea-pdf/private-vulnerability-reporting
```
Expected: repo edit prints the repo URL; the PUT returns 204 (empty).

- [ ] **Step 2: Apply branch protection to main**

```bash
gh api -X PUT repos/oddFEELING/chowbea-pdf/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": {"strict": false, "contexts": ["api", "web"]},
  "enforce_admins": true,
  "required_pull_request_reviews": {"required_approving_review_count": 0},
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```
Expected: JSON echo of the protection config.

- [ ] **Step 3: Verify direct pushes are rejected**

```bash
git commit --allow-empty -m "protection probe" && git push origin main; git reset --hard HEAD~1
```
Expected: push REJECTED with a protected-branch message (then the local probe commit is discarded).

---

### Task 2: Community files (branch `open-source-kit`)

**Files:**
- Create: `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml`, `.github/PULL_REQUEST_TEMPLATE.md`
- Rewrite: `README.md`

- [ ] **Step 1: Create the branch**

```bash
git checkout -b open-source-kit
```

- [ ] **Step 2: Write the files**

Content requirements (writer composes prose; these points are binding):
- `LICENSE`: standard MIT text, `Copyright (c) 2026 Emmanuel Alawode`.
- `README.md`: what it is + live URL https://pdf.chowbea.com; tools (compress/lock/unlock) all queued through RabbitMQ with public `/queue` board and 3-way concurrency; architecture block diagram (web ↔ api ↔ RabbitMQ, Railway deploy); prerequisites (bun ≥1.3, uv, Ghostscript, Docker for local broker); quickstart `make install` → `make rabbit` → `make dev`; test commands `cd api && uv run pytest` and `cd web && bun run test && bun run typecheck`; CI/CD note (PRs run CI; merges to main auto-deploy the changed service); links to CONTRIBUTING.md, LICENSE, purpose.md.
- `CONTRIBUTING.md`: setup (same commands), running suites, PR flow (fork → branch → PR to main; the `api` and `web` checks must pass; direct pushes to main are blocked for everyone), open an issue before large features, commit style (short imperative subject, e.g. "Add queue board page"), note that CI holds no secrets and main auto-deploys to prod so PRs never touch prod.
- `CODE_OF_CONDUCT.md`: Contributor Covenant v2.1 full text, contact `platforms@chowbea.com`.
- `SECURITY.md`: private reporting via GitHub advisories or `platforms@chowbea.com`; in scope: uploaded files, passwords, job queue; no public issues for vulnerabilities.
- `bug_report.yml`: form with fields — what happened (textarea, required), expected (textarea), steps (textarea, required), tool dropdown (Compress/Lock/Unlock/Queue page/API/Local dev), environment (input).
- `feature_request.yml`: problem (textarea, required), proposed solution (textarea), alternatives (textarea).
- `PULL_REQUEST_TEMPLATE.md`: checklist — linked issue, `uv run pytest` passes, `bun run test && bun run typecheck` pass, single focused change.

- [ ] **Step 3: Commit**

```bash
git add LICENSE README.md CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md .github/
git commit -m "Add open source community files and refreshed README"
```

---

### Task 3: Deploy traceability in the api

**Files:**
- Modify: `api/app/core/config.py` (add field), `api/app/main.py` (health + version)
- Test: `api/tests/test_config.py`, new assertions

**Interfaces:**
- Produces: `settings.commit_sha: str` default `"dev"`, env `RAILWAY_GIT_COMMIT_SHA` (no CHOWBEA_ prefix, via `validation_alias`).

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_config.py`:
```python
def test_commit_sha_defaults_to_dev():
    settings = Settings(_env_file=None)
    assert settings.commit_sha == "dev"


def test_health_reports_commit(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["commit"] == "dev"
```
(`client` fixture comes from `api/tests/conftest.py`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd api && uv run pytest tests/test_config.py -v`
Expected: FAIL — no `commit_sha` attribute / no `commit` key.

- [ ] **Step 3: Implement**

`api/app/core/config.py` — add `Field` import (`from pydantic import Field`) and, after `job_concurrency`:
```python
    # Git SHA of the running deploy; Railway injects this on git-connected
    # deploys. Read without the CHOWBEA_ prefix, hence the explicit alias.
    commit_sha: str = Field(default="dev", validation_alias="RAILWAY_GIT_COMMIT_SHA")
```
`api/app/main.py` — version + health:
```python
app = FastAPI(
    title=settings.app_name,
    version=(
        settings.app_version
        if settings.commit_sha == "dev"
        else f"{settings.app_version}+{settings.commit_sha[:7]}"
    ),
    lifespan=lifespan,
)
```
```python
@app.get("/health", tags=["meta"], summary="Liveness check")
def health() -> dict[str, str]:
    """Return a status payload used by load balancers, uptime checks, and
    bug reports (the commit identifies the running deploy)."""
    return {"status": "ok", "commit": settings.commit_sha[:7]}
```

- [ ] **Step 4: Run full api suite**

Run: `cd api && uv run pytest`
Expected: 27 passed.

- [ ] **Step 5: Commit**

```bash
git add api/app/core/config.py api/app/main.py api/tests/test_config.py
git commit -m "Surface the deployed commit SHA in /health and the OpenAPI version"
```

---

### Task 4: PR, merge through the protected flow, verify prod

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin open-source-kit
gh pr create --repo oddFEELING/chowbea-pdf --base main --head open-source-kit \
  --title "Open source contribution kit" \
  --body "MIT license, community docs, issue/PR templates, and deploy traceability (/health now reports the running commit). Per docs/superpowers/specs/2026-07-02-open-source-kit-design.md."
```

- [ ] **Step 2: Wait for checks, merge**

```bash
gh pr checks --repo oddFEELING/chowbea-pdf --watch
gh pr merge --repo oddFEELING/chowbea-pdf --merge --delete-branch
```
Expected: both `api` and `web` checks pass; merge succeeds; branch deleted.

- [ ] **Step 3: Verify prod traceability and skipped web deploy**

```bash
git checkout main && git pull
sleep 90   # allow Railway build+deploy
curl -s https://api-production-9ae1.up.railway.app/health   # expect {"status":"ok","commit":"<merge sha7>"}
railway deployment list --service web --limit 1 --json      # expect SKIPPED for the merge commit
```
Expected: `commit` equals the first 7 chars of the merge commit on main.

- [ ] **Step 4: Verify GitHub community surfaces**

```bash
gh api repos/oddFEELING/chowbea-pdf/community/profile --jq '.files | keys'
```
Expected: includes code_of_conduct, contributing, license, readme, issue_template, pull_request_template.
