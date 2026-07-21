# APA 7 Automated Review Web App

Monorepo for a hybrid APA 7 thesis review application with:

- React + Vite frontend
- Express backend
- DOCX parsing via `mammoth`
- PDF text extraction via `pdf-parse`
- Rule-based APA heuristics
- OpenAI structured-output review
- Server-Sent Events for progressive streaming updates

Current version: v2.0.0 | [![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20346509.svg)](https://doi.org/10.5281/zenodo.20346509)


## Workspace Layout

- `client/` React streaming UI
- `server/` Express API, job pipeline, APA checks, SSE stream

## Setup

1. Install dependencies from the repo root:

```bash
npm install
```

2. Copy the environment template and set your OpenAI API key:

```bash
cp .env.example .env
```

3. Start the app:

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`

## Environment Variables

- `PORT`: Express port. Default `3001`
- `OPENAI_API_KEY`: Required for the LLM review stage
- `OPENAI_MODEL`: Structured output capable model. Default `gpt-5-mini`
- `OPENAI_TIMEOUT_MS`: Per-request OpenAI timeout. Default `240000`
- `OPENAI_MAX_RETRIES`: OpenAI SDK retry count. Default `1`
- `LLM_DELTA_FLUSH_MS`: Coalescing window for `llm_delta` stream events. Default `120`
- `MAX_UPLOAD_BYTES`: Upload size limit for DOCX/PDF files. Default `3145728`
- `JOB_TTL_MS`: How long completed jobs remain streamable. Default `3600000`
- `APP_PASSWORD`: Optional shared password. If unset, the app remains open.
- `APP_SESSION_SECRET`: Optional cookie-signing secret. Defaults to `APP_PASSWORD`.
- `APP_AUTH_HOST`: Optional hostname scope for the password gate. Default example: `apa.lingviz.com`
- `AUTH_SESSION_TTL_MS`: Optional auth session lifetime in milliseconds. Default `604800000`

## API

### `POST /api/review`

Accepts multipart form data with a `file` field.

- Only `.docx` or `.pdf`
- Max size defaults to 3 MB
- Returns `202` with a `jobId`

### `POST /api/review/stream`

Accepts the same multipart form data (plus an optional `reviewMode` of `standard` or `comprehensive`) and returns a streamed `text/event-stream` response. This is the production Lambda-compatible review endpoint.

Emits:

- `snapshot` — full job state (used to initialize the client)
- `status` — `{ stage, message, progress, level, timestamp }`
- `section` — one APA section result as soon as it is computed
- `llm_delta` — coalesced OpenAI output chunks: `{ delta, previewLength, timestamp }` (the accumulated text is intentionally **not** resent per event)
- `complete` — `{ report }` with the final compliance JSON (version `3.1.0`)
- `review_error`

### `POST /api/review/annotate`

Accepts multipart form data with the original `.docx` in `file` plus an `issues` field: a JSON array of report `issueInventory` items (max 200; only the string fields each issue needs are read). Returns a copy of the document with native Word comments anchored to the paragraphs matching each issue's excerpt, as a `.docx` attachment named `<original-basename>-annotated.docx`. The `X-Annotated-Count` and `X-Unanchored-Count` response headers report how many issues were (not) anchored. DOCX only — PDF uploads are rejected with `400`.

### `GET /api/review/stream/:jobId`

Legacy local endpoint for jobs created through `POST /api/review` (same events as the streaming POST). The web client no longer uses this pair — cross-invocation resume on Lambda would require an external job store, so reconnecting mid-review restarts the run.

## Review Pipeline

1. Parse the uploaded DOCX or PDF into extracted text
2. For DOCX uploads, measure layout directly from the file's XML: margins, default font and size, line spacing, first-line and hanging indents, page-number fields, Word heading styles, and title emphasis (`analyzing_layout` stage)
3. Run local APA heuristics section by section — document structure, layout, title page, body/headings, citations, references — yielding to the event loop between sections so each `section` event streams as soon as it is computed
4. Run one OpenAI structured-output review over labeled line/reference excerpts, the rule-based findings, and the measured layout facts
5. Merge rule + model findings into a final report: duplicate AI findings fold into the matching rule item (`alsoFlaggedByLlm`), headline counts and the severity-weighted score derive from the deduplicated issue inventory, and the model's own score is reported separately as `summary.aiAssessment`

## Testing

- `npm test` runs the server unit suite (`node --test`), covering the parser zone split, citation/reference heuristics (with regression cases for known false positives), report merging/scoring, and the DOCX layout analyzer against generated fixtures.
- `npm run smoke:review -- http://127.0.0.1:3001` uploads a generated DOCX to a running server and asserts the full streamed contract (works without an OpenAI key; the LLM stage reports as skipped).
- CI runs the unit suite, the client build, and a keyless smoke test.

## Notes

- Text-based checks come from extracted document text; layout checks (margins, font, spacing, indents, page numbers) are measured from DOCX stored settings and are unavailable for PDFs.
- If `OPENAI_API_KEY` is missing, the application still completes using the rule-based report and flags the LLM stage as skipped.
- In production, the Express server will serve `client/dist` automatically after the frontend build exists.
- If `APP_PASSWORD` is set, the UI shows a password screen and the review endpoints require a valid auth cookie. If `APP_AUTH_HOST` is set, that gate only activates on that hostname.

## AWS Deployment

This repo includes a Lambda container build, a Lambda deployment workflow, and AWS IAM/CloudFormation templates. See [`docs/aws-lambda.md`](docs/aws-lambda.md) before deploying.
