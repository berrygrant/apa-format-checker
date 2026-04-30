# AWS Lambda Deployment

This repo deploys the React + Express app as a Lambda container image behind a Lambda Function URL with response streaming enabled. `apa.lingviz.com` is routed through CloudFront to keep the custom HTTPS hostname.

## Why the review endpoint changed

Lambda can freeze execution after a response is returned, so the old ECS flow of `POST /api/review` starting background work and `GET /api/review/stream/:jobId` reading in-memory job state is not reliable on Lambda.

The production UI now uses:

- `POST /api/review/stream`
- multipart `file` and `reviewMode` fields
- `text/event-stream` response body with the same `snapshot`, `status`, `section`, `llm_delta`, `complete`, and `review_error` events

The legacy endpoints remain for local compatibility, but Lambda clients should use the streaming POST.

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
