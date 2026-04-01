# AWS ECS Fargate Deployment

This repo is set up to deploy the app as a single-container ECS service on Fargate behind an Application Load Balancer.

## Important limitation

The review job store is in process memory in `server/src/lib/jobStore.js`. Because of that:

- run the ECS service with `desiredCount = 1`
- do not scale horizontally yet
- expect in-flight jobs to be lost if the task is replaced during deployment

If you want multi-task ECS later, move job state and SSE subscriptions to shared infrastructure first.

## Files added for AWS deployment

- `Dockerfile`
- `.dockerignore`
- `.github/workflows/deploy-ecs.yml`
- `.github/workflows/publish-image.yml`
- `infra/aws/ecs/task-definition.json`
- `infra/aws/iam/github-actions-oidc-trust-policy.json`
- `infra/aws/iam/github-actions-deploy-policy.json`

## Recommended AWS shape

- `ECR` repository for the container image
- `ECS` cluster using Fargate
- `ECS` service with `desiredCount = 1`
- `Application Load Balancer` targeting container port `3001`
- `CloudWatch Logs` group `/ecs/thesis-apa-formatter`
- `Secrets Manager` JSON secret for `OPENAI_API_KEY`, `APP_PASSWORD`, and `APP_SESSION_SECRET`

Use `/api/health` for both the container health check and the target group health check.

## ECS service settings

Recommended starting values:

- task CPU: `1024`
- task memory: `2048`
- container port: `3001`
- target group health path: `/api/health`
- ALB idle timeout: `300` seconds

The app sends SSE heartbeats every 15 seconds, so the stream should stay active behind an ALB, but a longer idle timeout gives you more headroom for operational debugging.

## Security model

Use GitHub Actions OIDC instead of long-lived AWS keys.

1. Create an IAM OIDC provider in AWS for `https://token.actions.githubusercontent.com`.
2. Create an IAM role for GitHub Actions named `GitHubActionsDeploy-thesis-apa-formatter` with the trust policy in `infra/aws/iam/github-actions-oidc-trust-policy.json`.
3. Attach a least-privilege policy similar to `infra/aws/iam/github-actions-deploy-policy.json`.
4. Restrict the trust policy to the GitHub `production` environment.
5. Add required reviewers to the GitHub `production` environment before the deploy workflow is allowed to run.

## GitHub environment variables

Create a GitHub environment named `production`, then add these environment variables:

- `AWS_REGION`
- `AWS_ROLE_TO_ASSUME`
- `ECR_REPOSITORY`
- `ECS_CLUSTER`
- `ECS_SERVICE`
- `ECS_CONTAINER_NAME`

Recommended values:

- `AWS_REGION=us-east-1`
- `AWS_ROLE_TO_ASSUME=arn:aws:iam::723173543836:role/GitHubActionsDeploy-thesis-apa-formatter`
- `ECS_CONTAINER_NAME=thesis-apa-formatter`
- `ECR_REPOSITORY=thesis-apa-formatter`
- `ECS_CLUSTER=thesis-apa-formatter`
- `ECS_SERVICE=thesis-apa-formatter`

## AWS resources to create

### 1. ECR repository

Create a private ECR repository named `thesis-apa-formatter`.

### 2. Secrets Manager secret

Create a Secrets Manager secret as a JSON object and store all three application secrets in it:

```json
{
  "OPENAI_API_KEY": "sk-...",
  "APP_PASSWORD": "your-shared-password",
  "APP_SESSION_SECRET": "a-long-random-cookie-signing-secret"
}
```

The task definition expects JSON-key selectors on the existing secret ARN in `infra/aws/ecs/task-definition.json`.

### 3. CloudWatch Logs group

Create `/ecs/thesis-apa-formatter`.

### 4. ECS task execution role

Create an execution role named `ecsTaskExecutionRole-thesis-apa-formatter`.

It needs:

- the AWS managed policy `AmazonECSTaskExecutionRolePolicy`
- the inline policy in `infra/aws/iam/ecs-task-execution-secrets-policy.json`

### 5. ECS cluster and service

Create:

- cluster: `thesis-apa-formatter`
- service: `thesis-apa-formatter`

Attach the service to an ALB target group on port `3001`.

## Exact setup order

### 1. GitHub environment

In GitHub, open:

- `Settings -> Environments -> New environment`

Create `production`, then add:

- required reviewers: at least yourself
- environment variables:
  - `AWS_REGION=us-east-1`
  - `AWS_ROLE_TO_ASSUME=arn:aws:iam::723173543836:role/GitHubActionsDeploy-thesis-apa-formatter`
  - `ECR_REPOSITORY=thesis-apa-formatter`
  - `ECS_CLUSTER=thesis-apa-formatter`
  - `ECS_SERVICE=thesis-apa-formatter`
  - `ECS_CONTAINER_NAME=thesis-apa-formatter`

### 2. AWS IAM OIDC provider

In AWS IAM, create an OIDC identity provider if one does not already exist:

- provider URL: `https://token.actions.githubusercontent.com`
- audience: `sts.amazonaws.com`

### 3. GitHub deploy role

Create IAM role:

- role name: `GitHubActionsDeploy-thesis-apa-formatter`
- trusted entity type: `Web identity`
- identity provider: `token.actions.githubusercontent.com`
- audience: `sts.amazonaws.com`

Use the trust policy in `infra/aws/iam/github-actions-oidc-trust-policy.json` and attach the policy in `infra/aws/iam/github-actions-deploy-policy.json`.

### 4. ECS task execution role

Create IAM role:

- role name: `ecsTaskExecutionRole-thesis-apa-formatter`
- trusted entity type: `AWS service`
- use case: `Elastic Container Service Task`

Attach:

- `AmazonECSTaskExecutionRolePolicy`
- inline policy from `infra/aws/iam/ecs-task-execution-secrets-policy.json`

### 5. ECR, log group, and cluster

Create these AWS resources:

- ECR repository: `thesis-apa-formatter`
- CloudWatch log group: `/ecs/thesis-apa-formatter`
- ECS cluster: `thesis-apa-formatter`

### 6. Load balancer and service

Create an Application Load Balancer and ECS service with these settings:

- launch type: `Fargate`
- desired tasks: `1`
- task definition family: `thesis-apa-formatter`
- container name: `thesis-apa-formatter`
- container port: `3001`
- target group protocol: `HTTP`
- target group health check path: `/api/health`
- ALB idle timeout: `300` seconds

For a simple staging deployment, the least-complicated networking setup is:

- ALB in two public subnets
- ECS tasks in the same VPC
- task security group allows inbound `3001` only from the ALB security group
- task outbound internet access is enabled so the app can call OpenAI

If you use private subnets for tasks, make sure those subnets have NAT egress.

### 7. First bootstrap image

Before the GitHub deploy workflow can update the ECS service, the service needs an initial task definition revision that points at a valid image URI:

- `723173543836.dkr.ecr.us-east-1.amazonaws.com/thesis-apa-formatter:bootstrap`

Use the `Publish Image to ECR` GitHub Actions workflow to push that initial image, then create the ECS service.

## Deploy flow

1. Push to `main`, or trigger `Deploy to ECS` manually in GitHub Actions.
2. The workflow builds the Docker image.
3. The image is pushed to ECR.
4. GitHub Actions renders the task definition with the new image tag.
5. ECS updates the service and waits for stability.

## Before first deploy

The repo templates are now prefilled for:

- AWS account `723173543836`
- AWS region `us-east-1`
- OpenAI secret `arn:aws:secretsmanager:us-east-1:723173543836:secret:prod/apa-format-checker-nhpYMl`
- Required JSON keys inside that secret: `OPENAI_API_KEY`, `APP_PASSWORD`, and `APP_SESSION_SECRET`
- GitHub repo `berrygrant/apa-format-checker`

Before deploying, verify those values still match the AWS resources you create.

## Operational notes

- This app stores uploads and review state in memory only.
- ECS rolling deploys can interrupt active reviews.
- For a Chair demo, keep the service single-task and treat it as a controlled staging app.
- If you later want persistence, add S3 for uploads/exports and a shared store for job state.
