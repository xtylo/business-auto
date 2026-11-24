# Session 8 — Deployment and wrap-up

Everything built so far goes to a real AWS account, gets verified, and is destroyed again
within the hour. Then the README is rewritten to describe what was actually built and measured.

**This session spends money**, or credits. The stack contains resources that are billed for
every hour they exist, used or not. The whole plan depends on step 9: `cdk destroy`.

## Before you start

### Where the commands run

All commands in this session run in **Windows PowerShell**, from the repository folder, not
in the dev container. `cdk deploy` has to build the Docker image, and the dev container has
no Docker.

You need on Windows: Node.js (you used it in session 1), Docker Desktop **running**, and the
AWS CLI version 2.32 or later.

```powershell
winget install -e --id Amazon.AWSCLI     # then open a NEW PowerShell window
aws --version
```

### Check your account plan

New AWS accounts are on either a **Free plan** or a **Paid plan**. The Free plan gives access
to a limited set of services; credits apply on both. This stack uses ECS on Fargate, an
Application Load Balancer, a NAT gateway, ElastiCache, Cloud Map, ECR and CloudWatch Logs.

1. Open the Billing and Cost Management console and see which plan the account is on.
2. If it is on the Free plan, compare the services above with the list of services the Free
   plan supports. If any is missing, the deployment will fail on that resource and roll back.

Upgrading to the Paid plan removes the restriction and keeps the remaining credits, but once
credits run out, usage is charged to your card. That decision is yours.

### Set a budget alert

In the Billing console, create a budget (for example 5 USD per month) with an e-mail alert.
It takes two minutes and is the cheapest insurance against a forgotten stack.

### What this costs

The hourly resources are the NAT gateway, the load balancer, the Redis node, four Fargate
tasks and three public IPv4 addresses. At list prices for a US region this adds up to roughly
20 US cents per hour: an estimate from memory, not a quote. Use the AWS Pricing Calculator
for an exact figure. Left running for a month, the same stack would cost well over 100 USD.

## Steps

### 0. Rehearse with the production image, locally and for free

The dev container runs the code with `npm run ...`. AWS runs the **image** built from
`Dockerfile`, which nobody has started yet. Run that exact image against the local Temporal
and Redis first: a problem found here costs nothing and takes seconds to see.

In PowerShell, from the repository root, with the dev container's own worker and API stopped:

```powershell
docker build -t business-auto .

# Window 1: the worker, exactly as ECS starts it
docker run --rm --network business-auto_default -e TEMPORAL_ADDRESS=temporal:7233 business-auto node src/worker.js

# Window 2: the API, exactly as ECS starts it (published on port 3100)
docker run --rm --network business-auto_default -e TEMPORAL_ADDRESS=temporal:7233 -e REDIS_URL=redis://redis:6379 -p 3100:3000 business-auto

# Window 3
npm run smoke -- http://localhost:3100
```

Six `PASS` lines mean the image is good. If a container exits instead, its error is right
there in the window. Stop both containers with Ctrl+C before going on.

### 1. Sign in from the command line

Do not use the root user for this. In the IAM console create a user for yourself with the
`AdministratorAccess` policy and console access, and sign in to the console as that user.

```powershell
aws login
aws configure set region us-west-2
aws sts get-caller-identity
```

`aws login` opens the browser and gives the CLI short-lived credentials from your console
session; no access key is stored on disk. The last command must print your account ID and
your IAM user.

If a later `cdk` command reports that it cannot find credentials, the CDK version does not
read that kind of session yet. Fall back to an access key: create one for your IAM user, run
`aws configure`, and delete the key in the IAM console when the session is over.

### 2. Install the CDK project on Windows

```powershell
cd infra
npm ci
```

The folder was installed from Linux inside the dev container; `npm ci` recreates the command
shims Windows needs. Stay in `infra` for the next steps.

### 3. Bootstrap (once per account and region)

```powershell
npx cdk bootstrap
```

CDK needs a few resources of its own before it can deploy anything: an S3 bucket for
templates, an ECR repository for container images, and IAM roles. This creates them in a
stack called `CDKToolkit`.

### 4. Review what will be created

```powershell
npx cdk diff
```

Against an empty account the diff is "everything". Read the **IAM Statement Changes** and
**Security Group Changes** tables at the top: this is the security review of the stack, and
the same two tables the infrastructure tests assert on.

### 5. Deploy

```powershell
npx cdk deploy
```

Answer `y` when it asks to approve the security changes. Then, in order:

1. Docker builds the image from `Dockerfile` and pushes it to ECR.
2. CloudFormation creates the 59 resources. Expect 10 to 15 minutes; Redis and the NAT
   gateway are the slow ones.

While it runs, open the CloudFormation console → `BusinessAutoStack` → **Events** and watch
the resources appear in dependency order. When it finishes, the terminal prints the outputs:

```
BusinessAutoStack.ApiUrl = http://Busine-ApiLB-....elb.amazonaws.com
BusinessAutoStack.ClusterName = ...
BusinessAutoStack.LogGroupName = ...
```

Keep them at hand:

```powershell
$url   = "<ApiUrl from the output>"
$logs  = "<LogGroupName from the output>"
```

### 6. Production checklist

```powershell
curl.exe -i "$url/health"
```

- [ ] **Load balancer healthy:** the command above returns `200` and `{"status":"ok"}`.
      In the EC2 console → Target Groups, both API targets are `healthy`.
- [ ] **Services running:** in the ECS console → the cluster → Services, all three show the
      desired number of tasks running (API 2, worker 1, Temporal 1).
- [ ] **Worker connected to Temporal:**
      ```powershell
      aws logs tail $logs --since 20m --log-stream-name-prefix worker
      ```
      It should show `Worker listening on task queue "business-processes"`.
- [ ] **API connected:**
      ```powershell
      aws logs tail $logs --since 20m --log-stream-name-prefix api
      ```
      It should show `API listening`, with no `Redis error` lines repeating.

### 7. Smoke test

```powershell
cd ..
npm run smoke -- $url
```

This drives one invoice through the whole process over the public URL: start, wait for the
worker, approve, wait for `PAID`, and check that a duplicate is rejected. Six lines of `PASS`
mean the load balancer, the API, Redis, Temporal and the worker all work together on AWS.

Try a few requests by hand too, the same ones as in session 4, replacing
`http://localhost:3000` with `$url`.

### 8. Optional: measure it

```powershell
docker compose --profile loadtest run --rm -e BASE_URL=$url k6 run /scripts/k6.js
docker compose --profile loadtest run --rm -e BASE_URL=$url -e SCENARIO=reads k6 run /scripts/k6.js
```

The smoke and reads scenarios only. These numbers include the internet round trip from your
machine to the AWS region, so compare them with care against the local ones. Add them to
`docs/load-test-results.md`.

### 9. Destroy

```powershell
cd infra
npx cdk destroy
```

Answer `y`. It takes about 10 minutes. **Do not close the session before this finishes.**

Then confirm, in the console of the region you used:

- [ ] CloudFormation: `BusinessAutoStack` is gone (not `DELETE_FAILED`).
- [ ] EC2 → NAT gateways: none in state `Available`.
- [ ] EC2 → Load balancers: none.
- [ ] ElastiCache: no clusters.
- [ ] ECS: no clusters.

The CloudWatch log group is also kept on purpose, so that logs survive a failed deployment.
It costs nothing once its entries expire after a week. To delete it now:

```powershell
aws logs describe-log-groups --log-group-name-prefix BusinessAutoStack --query "logGroups[].logGroupName"
aws logs delete-log-group --log-group-name "<name from the list>"
```

What also remains on purpose is the `CDKToolkit` bootstrap stack: its bucket and image repository
cost cents per month and make the next deploy faster. To remove everything, delete the images
in the `cdk-...-container-assets-...` ECR repository, empty the `cdk-...-assets-...` S3
bucket, and delete the `CDKToolkit` stack.

Tomorrow, look at Billing → Cost Explorer to see what the hour actually cost.

## If the deployment fails

CloudFormation rolls back by itself and deletes what it created. Check the Events tab for the
first resource in `CREATE_FAILED`; its status reason says why.

| Symptom | Likely cause and fix |
| --- | --- |
| A resource fails with "not authorized" or "not subscribed" for a service | The account plan does not include that service. See "Check your account plan" |
| `docker: error during connect` while building | Docker Desktop is not running |
| `cdk` says it cannot find credentials | See the fallback in step 1 |
| `This stack uses assets, so the toolkit stack must be deployed` | Step 3 was skipped, or ran in another region |
| `ECS Deployment Circuit Breaker was triggered` on a service | Its container kept exiting. The log group survives the rollback: find it with `aws logs describe-log-groups --log-group-name-prefix BusinessAutoStack`, then `aws logs tail <name> --since 2h`. Then reproduce with step 0 |
| API log shows `REDIS_URL "redis://:" is not usable` | The Redis endpoint reached the container empty. This happened with the `CfnCacheCluster` resource and is why the stack uses `CfnReplicationGroup`. The API keeps running without Redis; fix the stack and redeploy |
| Smoke test gets `503` from a healthy API | The API is up but cannot reach Temporal. Check the Temporal task is running and read the `api` and `temporal` log streams |
| The Temporal task fails to pull its image | Docker Hub rate limit from the NAT address. Deploy again after a few minutes |
| `cdk destroy` ends in `DELETE_FAILED` | Open the stack in CloudFormation, see which resource is stuck, delete it by hand, and run `cdk destroy` again |
| The stack is stuck in `ROLLBACK_COMPLETE` | Run `npx cdk destroy`, then deploy again |

## What went wrong on the first attempts

Two deployments failed with `ECS Deployment Circuit Breaker was triggered` on the API service.

- **Cause:** the stack created Redis with `CfnCacheCluster` and built `REDIS_URL` from its
  `RedisEndpoint` attributes. At deploy time both came back empty, the API received
  `redis://:`, and the Redis client threw `Invalid URL` during startup. Three crashed tasks
  later, ECS stopped the deployment and CloudFormation rolled everything back.
- **Why it was not caught earlier:** `cdk synth` and the template tests only see a reference
  to the attribute, not its value. The value exists only inside AWS, at deploy time.
- **Why the first failure showed no cause:** the log group was deleted by the rollback, and
  the API printed nothing before failing. The second attempt kept the log group and printed
  its configuration first, and the cause was readable in one line.
- **Fixes:** Redis is now a `CfnReplicationGroup`, read through its primary endpoint; a
  template test pins that; and the API no longer exits on an unusable Redis URL, in line with
  the rule that Redis is never required.

## What this deployment is, and is not

- The Temporal server is the development build, as one task, with state in memory. It proves
  the system works end to end on AWS. It is not how Temporal runs in production.
- The API is served over plain HTTP. HTTPS needs a domain name and a certificate.
- There is one NAT gateway and one Redis node: no redundancy.
- Metrics ports are not exposed and no Prometheus runs in AWS; logs go to CloudWatch.

## Check yourself

- Which resources kept costing money every hour even with zero requests?
- `cdk deploy` built and pushed a Docker image. Where did the image go, and who created that
  repository?
- Why can the smoke test tell that the *worker* is working when it only talks to the API?
- If the worker task had crashed after deployment, what would the smoke test have shown, and
  what would have happened to the invoice it started?
- What would you change first to make this production-ready?

## Done when

- [ ] `npx cdk deploy` finished and printed the API URL.
- [ ] The production checklist is complete.
- [ ] `npm run smoke -- $url` shows six `PASS` lines.
- [ ] `npx cdk destroy` finished and the console shows nothing left running.
- [ ] The README describes what was built and measured.
- [ ] Commit created: `Session 8: deployment and final README`
