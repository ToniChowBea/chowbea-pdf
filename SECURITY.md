# Security Policy

Chowbea PDF processes user-uploaded files and passwords, so security reports
are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately, either way works:

- GitHub: use [private vulnerability reporting](https://github.com/oddFEELING/chowbea-pdf/security/advisories/new)
- Email: platforms@chowbea.com

You'll get an acknowledgement within a few days. Please include reproduction
steps and, if relevant, the commit shown by the API's `/health` endpoint.

## Scope

Especially in scope — anything touching:

- Uploaded PDF files (storage, retention, cross-user access to results)
- Passwords sent to the lock/unlock tools (logging, exposure, transit)
- The job queue (job-id guessing, access to other people's downloads,
  information leaks on the public queue board)

## Out of scope

- Denial of service by uploading many large files (known trade-off of a free
  anonymous tool; rate limiting is on the roadmap)
- Reports from automated scanners without a demonstrated impact
