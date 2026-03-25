# APA 7 Automated Review Web App

Monorepo for a hybrid APA 7 thesis review application with:

- React + Vite frontend
- Express backend
- DOCX parsing via `mammoth`
- Rule-based APA heuristics
- OpenAI structured-output review
- Server-Sent Events for progressive streaming updates

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
- `MAX_UPLOAD_BYTES`: DOCX upload size limit. Default `3145728`
- `JOB_TTL_MS`: How long completed jobs remain streamable. Default `3600000`

## API

### `POST /api/review`

Accepts multipart form data with a `file` field.

- Only `.docx`
- Max size defaults to 3 MB
- Returns `202` with a `jobId`

### `GET /api/review/stream/:jobId`

Server-Sent Events endpoint that emits:

- `snapshot`
- `status`
- `section`
- `llm_delta`
- `complete`
- `review_error`

## Review Pipeline

1. Parse the DOCX with `mammoth`
2. Extract:
   - title page excerpt
   - body excerpt
   - references section
3. Run local APA heuristics
4. Stream intermediate section updates
5. Run OpenAI structured review on extracted content
6. Merge local + model findings into a final APA compliance JSON report

## Notes

- The rule-based layer intentionally focuses on checks that can be inferred from raw DOCX text.
- If `OPENAI_API_KEY` is missing, the application still completes using the rule-based report and flags the LLM stage as skipped.
- In production, the Express server will serve `client/dist` automatically after the frontend build exists.

## AWS Deployment

This repo now includes a container build, an ECS deployment workflow, and AWS IAM/task templates for ECS Fargate. See [`docs/aws-ecs-fargate.md`](docs/aws-ecs-fargate.md) before deploying.
