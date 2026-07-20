# APA Format Checker — agent notes

Hybrid APA 7 thesis review app: React/Vite client (`client/`), Express server (`server/`), deployed as a Lambda container behind CloudFront. See `README.md` for the pipeline and `docs/AUDIT-2026-07.md` for the 2026 audit record.

## Git conventions

- Author all commits and merges as the repository owner, with Claude as co-author:
  - Before committing, run: `git config user.name "Grant M. Berry" && git config user.email "berry.grant@gmail.com"`
  - Keep the `Co-Authored-By: Claude ...` trailer in commit messages.

## Working on this repo

- `npm test` — server unit suite (node:test); must stay green.
- `npm run check` — client build + server syntax checks + tests.
- `npm run smoke:review -- http://127.0.0.1:3001` — end-to-end streamed review against a running server; works without an OpenAI key.
- SSE event names (`snapshot`, `status`, `section`, `llm_delta`, `complete`, `review_error`) are a stable contract between server, client, and the smoke script — change payloads only in lockstep.
