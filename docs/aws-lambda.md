# AWS Lambda Deployment

This repo deploys the React + Express app as a Lambda container image behind a Lambda Function URL with response streaming enabled. `apa.lingviz.com` is routed through CloudFront to keep the custom HTTPS hostname.

## Why the review endpoint changed

Lambda can freeze execution after a response is returned, so the old ECS flow of `POST /api/review` starting background work and `GET /api/review/stream/:jobId` reading in-memory job state is not reliable on Lambda.

The production UI now uses:

- `POST /api/review/stream`
- multipart `file` and `reviewMode` fields
- `text/event-stream` response body with the same `snapshot`, `status`, `section`, `llm_delta`, `complete`, and `review_error` events

The legacy endpoints remain for local compatibility, but Lambda clients should use the streaming POST.

## CloudFront caching

The distribution has two behaviors:

- `/assets/*` (Vite's content-hashed bundles) uses the managed CachingOptimized policy with `Compress: true`, and Express serves those files with `Cache-Control: public, max-age=31536000, immutable`. Page loads after the first hit the edge cache with gzip/brotli instead of pulling the full bundle through Lambda.
- The default behavior stays on CachingDisabled with `Compress: false` — required so the SSE review stream is never buffered or compressed. `index.html` is served `no-cache`, so deploys roll out immediately.

If the Vite `base`/output directory ever changes from `/assets/`, the `CacheBehaviors` path pattern in `template.yml` must change with it. Template changes to `CacheBehaviors` trigger a CloudFront distribution update, which adds several minutes to that deploy.

## Files

- `Dockerfile` builds the app image and includes the AWS Lambda Web Adapter.
- `infra/aws/lambda/template.yml` creates the Lambda function, function URL, and execution role.
- `infra/aws/lambda/template.yml` also creates the CloudFront distribution for `apa.lingviz.com`.
- `.github/workflows/deploy-lambda.yml` builds the image, pushes it to ECR, deploys the CloudFormation stack, and UPSERTs the Route 53 alias records.
- `scripts/smoke-review-stream.mjs` verifies health, password login, streamed upload, and final report shape.
- `infra/aws/iam/github-actions-deploy-policy.json` is the deploy role policy for GitHub Actions.

## AWS resources

Recommended values:

- AWS account: `723173543836`
- AWS region: `us-east-1`
- ECR repository: `thesis-apa-formatter`
- CloudFormation stack: `thesis-apa-formatter-lambda`
- Lambda function: `thesis-apa-formatter`
- Secrets Manager secret: `prod/apa-format-checker`
- CloudFront/ACM custom domain: `apa.lingviz.com`
- Route 53 hosted zone: `Z06039273CWG1NUO8MR2K`

The secret must contain these JSON keys:

```json
{
  "OPENAI_API_KEY": "sk-...",
  "APP_PASSWORD": "your-shared-password",
  "APP_SESSION_SECRET": "a-long-random-cookie-signing-secret"
}
```

`APP_AUTH_HOST` is intentionally not set in Lambda. If `APP_PASSWORD` is present, the password gate applies to the Function URL and to `apa.lingviz.com`.

Optional tuning variables (defaults are set in code; override via the template if needed): `OPENAI_TIMEOUT_MS` (240000), `OPENAI_MAX_RETRIES` (1), and `LLM_DELTA_FLUSH_MS` (120) — the coalescing window for `llm_delta` SSE events.

## Job snapshot table (optional)

Each Lambda invocation is its own container, so the in-memory job store never survives a dropped `POST /api/review/stream` connection: a refresh or rejoin lands on a container that has never heard of the job. The optional DynamoDB job snapshot table closes that gap.

What it enables:

- While a review runs, the server debounce-saves the serialized job snapshot (stage, sections, LLM preview, final report) to DynamoDB, with an immediate save on completion or failure.
- `GET /api/review/stream/:jobId` falls back to the stored snapshot when the job is not in memory: it replays a `snapshot` event, then ends cleanly for completed/failed jobs, or ends with an "interrupted" `review_error` for jobs that were still mid-review.
- The client uses this automatically: when the streaming POST drops before a terminal event, it fetches the job stream once by id. A completed report renders normally after the drop; a mid-review snapshot renders with a "Connection dropped; showing the latest saved progress. Re-run to finish." notice.

What it does NOT do:

- It cannot live-resume an in-flight stream across containers. The OpenAI call runs inside the original invocation; another container can only show the latest saved state, never re-attach to the running review. If the original invocation itself is killed, the review stops and only the last saved snapshot remains.

How to enable:

1. Deploy the stack with `EnableJobSnapshotTable=true` (set the GitHub `production` environment variable `ENABLE_JOB_SNAPSHOT_TABLE=true`, or pass the parameter override to `aws cloudformation deploy`). This creates the `<FunctionName>-job-snapshots` table (PAY_PER_REQUEST, partition key `jobId`, TTL on `expiresAt`), grants the execution role `dynamodb:GetItem`/`PutItem` on it, and sets `JOB_SNAPSHOT_TABLE` in the function environment.
2. Nothing else is required. Snapshots expire with the existing `JOB_TTL_MS` (default 1 hour) via DynamoDB TTL; snapshots over 300 KB are stored gzipped+base64. With the parameter left at `"false"` (the default) the table, policy, and env var are absent and the server keeps its in-memory-only behavior.

## GitHub environment variables

Create or update the GitHub `production` environment variables:

- `AWS_REGION=us-east-1`
- `AWS_ROLE_TO_ASSUME=arn:aws:iam::723173543836:role/GitHubActionsDeploy-thesis-apa-formatter`
- `ECR_REPOSITORY=thesis-apa-formatter`
- `LAMBDA_FUNCTION_NAME=thesis-apa-formatter`
- `LAMBDA_STACK_NAME=thesis-apa-formatter-lambda`
- `LAMBDA_SECRET_ID=prod/apa-format-checker`
- `CUSTOM_DOMAIN_NAME=apa.lingviz.com`
- `CLOUDFRONT_CERTIFICATE_ARN=arn:aws:acm:us-east-1:723173543836:certificate/b1255947-4f28-4378-9017-7631ef894f2b`
- `ROUTE53_HOSTED_ZONE_ID=Z06039273CWG1NUO8MR2K`

## Deploy

Push to `main` or run the `Deploy to Lambda` workflow manually. The workflow:

1. Builds the Docker image for `linux/amd64`.
2. Pushes the image to ECR with the commit SHA and `latest` tags.
3. Deploys `infra/aws/lambda/template.yml` with CloudFormation.
4. Waits for the Lambda update to finish.
5. Points `apa.lingviz.com` at the CloudFront distribution.
6. Prints the Lambda Function URL and custom domain URL.

## Smoke test

Local server:

```bash
npm run start
npm run smoke:review -- http://127.0.0.1:3001
```

Production hostname:

```bash
SMOKE_SECRET_ID=prod/apa-format-checker npm run smoke:review -- https://apa.lingviz.com
```
