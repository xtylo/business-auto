# Work Plan — Business Process Automation Platform

8 sessions of at most 1 hour. Stack: JavaScript (Node.js 22), Temporal, Redis, AWS CDK v2, ALB, k6.
New technologies: **Temporal** (sessions 1–5) and **AWS CDK** (sessions 6 and 8).

Convention: all code, comments, Markdown and commit messages are written in English.

## Progress

- [x] Session 1 — Temporal: first workflow running *(done; notes in [docs/session-01.md](docs/session-01.md))*
- [x] Session 2 — The real process: invoices with retries *(done; notes in [docs/session-02.md](docs/session-02.md))*
- [x] Session 3 — Human wait: signals, queries, timers and compensation *(done; notes in [docs/session-03.md](docs/session-03.md))*
- [x] Session 4 — Express API + Redis *(done; notes in [docs/session-04.md](docs/session-04.md))*
- [x] Session 5 — Testing *(done; notes in [docs/session-05.md](docs/session-05.md))*
- [x] Session 6 — AWS CDK: infrastructure as code *(done; notes in [docs/session-06.md](docs/session-06.md))*
- [ ] Session 7 — Observability and load testing *(files in place; run the steps in [docs/session-07.md](docs/session-07.md))*
- [ ] Session 8 — Deployment and wrap-up

## How each session works

1. **Concept (10 min)** — the new idea, with its .NET/Azure equivalent.
2. **Build (40 min)** — small steps; you run them and see the result.
3. **Wrap-up (10 min)** — check the "done when" list, commit, and preview the next session.

Every session ends with something that runs. Anything that does not fit in the hour moves to "optional" and does not block the next session.

## Business process to automate (proposal)

**Supplier invoice approval**: receive invoice → validate → request human approval (with expiry and escalation) → record payment → post to ledger → notify. If the ledger step fails after payment, the payment is reverted.

It was chosen because it exercises what makes Temporal valuable: retries, long waits, human intervention and compensation. It can be swapped for another process without changing the plan.

## Adjustments to the base project

| What the base project had | Problem | What we do |
| --- | --- | --- |
| `src/src/*.js` | Duplicated folder; the README tests point to `src/` | Flattened to `src/` *(done)* |
| `workflows.js` creates a `WorkflowClient` | Mixes client and workflow; no worker, no Temporal server | Split into `workflows/`, `activities/`, `worker.js`, `client.js` *(done)* |
| `docker-compose.yml` with LocalStack `SERVICES=elb,redis` | LocalStack now requires an account and auth token; "redis" is not a LocalStack service; Temporal is missing | Compose with real Temporal + Redis *(done)*. CDK is validated with `cdk synth` and template tests |
| `cdk-stack.js` with `@aws-cdk/core` | That is CDK v1, unsupported since 2023; `vpc` is undefined | CDK v2 (`aws-cdk-lib`) in `infra/` *(done, session 6)* |
| `index.js` does not export `app` | The README integration test cannot import it | `app.js` exports, `server.js` listens *(done)* |
| `.devcontainer` references a missing `Dockerfile` | It does not start | Compose-based dev container with its own Dockerfile *(done, session 2)*. The production image is a separate Dockerfile (session 6) |
| k6: 1000 VUs with `sleep(1)` | Tops out near 1000 req/s, not the 2000 target; thresholds differ from the README | Arrival-rate scenarios and aligned thresholds *(done, session 7)* |

## Target repository layout

```
business-auto/
├── .devcontainer/        # development container (Node 22 + Temporal CLI)
├── src/
│   ├── workflows/        # deterministic code (runs in the sandbox)
│   ├── activities/       # side effects: HTTP, database, e-mail
│   ├── api/              # app.js, routes.js, store.js, server.js
│   ├── scripts/          # command-line starters
│   ├── worker.js
│   ├── client.js         # Temporal connection
│   ├── config.js
│   └── redis.js          # Redis connection
├── test/                 # activities, API and workflow tests
├── .github/workflows/    # CI
├── infra/                # CDK v2 app: bin/, lib/, test/
├── observability/        # Prometheus and Grafana configuration
├── docs/                 # session notes and load test results
├── loadtest/k6.js
├── docker-compose.yml
├── Dockerfile            # production image (API and worker)
└── README.md
```

## Prerequisites

- Docker Desktop running on Windows.
- VS Code with the Dev Containers extension (development happens inside the container from session 2 on).
- Git.

---

## Session 1 — Temporal: first workflow running

**Concept:** Workflow, Activity, Worker, Task Queue, and why a workflow must be deterministic. Equivalent: Durable Functions (orchestrator + activities); the event history covers what you would build with sagas + outbox in Wolverine.

**Steps**
1. `git init`, bring in the base project, flatten `src/`, `package.json`, `.gitignore`.
2. `docker-compose.yml` with Temporal (dev server + UI) and Redis.
3. `helloProcess` workflow + activities + `worker.js` + starter script.
4. Open the Temporal UI and read the execution's event history.
5. Experiment: stop the worker mid-execution, start it again and watch it continue.

**Done when:** the workflow shows "Completed" in the UI and you can explain what each event in its history did.

## Session 2 — The real process: invoices with retries

**Concept:** activity timeouts (`startToCloseTimeout`), retry policy, non-retryable errors, activity idempotency.

**Steps**
0. Move development into the dev container.
1. Diagram of the approval flow (covers Phase 1 of the README).
2. Activities: `validateInvoice`, `recordPayment`, `notify` (simulated, with repeatable failures driven by the attempt number).
3. `invoiceApproval` workflow chaining them, without human approval yet.
4. Trigger failures and watch the retries in the UI.
5. Mark "invalid invoice" as a non-retryable error.

**Done when:** an activity that fails twice succeeds on the third attempt with no intervention, and an invalid invoice fails immediately.

## Session 3 — Human wait: signals, queries, timers and compensation

**Concept:** Signal (external event), Query (read state), durable timer, saga pattern. Equivalent: `WaitForExternalEvent` and durable timers in Durable Functions.

**Steps**
1. `approve` / `reject` signals; the workflow waits with `condition()`.
2. Timer: no answer within N time escalates; no answer again rejects.
3. `status` query to see which step the process is on.
4. Compensation: if `postToLedger` fails permanently after `recordPayment`, run `revertPayment`. `notify` is best effort.
5. Exercise every path with the `npm run invoice` commands (or the Temporal CLI).

**Done when:** you can approve, reject and let an invoice expire, and all three paths look right in the UI.

## Session 4 — Express API + Redis

**Concept:** the Temporal client inside an API; Workflow ID as a business key; what Redis is for here (idempotency and status cache).

**Steps**
1. Single shared Temporal client connection for the API.
2. `POST /api/start-process` (starts the workflow, returns 202 with the id).
3. `GET /api/process/:id` (uses the query) and `POST /api/process/:id/approve|reject` (sends a signal).
4. Redis: `Idempotency-Key` to avoid duplicate starts, and a short-lived status cache.
5. Input validation and error handling (404 unknown process, 409 duplicate invoice or already finished).
6. Fail-open behaviour: the API keeps working when Redis is down.

**Done when:** the whole flow can be driven with `curl` alone, and repeating the same POST does not create a second process.

## Session 5 — Testing

**Concept:** testing workflows with Temporal's test environment (`@temporalio/testing`) and time skipping, so a timer of days is tested in milliseconds.

**Steps**
1. Jest set up; unit tests for activities.
2. Workflow tests with mocked activities: happy path, rejection, expiry, compensation.
3. API tests with supertest and a mocked Temporal client.
4. `npm test` script and a GitHub Actions workflow.
5. Break the workflow on purpose and watch the tests catch it; write one test yourself.

**Done when:** `npm test` passes and covers the four workflow paths.

## Session 6 — AWS CDK: infrastructure as code

**Concept:** App, Stack, Construct (L1/L2/L3 levels), `synth` → CloudFormation, `diff`, `bootstrap`. Equivalent: Bicep, but written in a programming language.

**Steps**
1. `Dockerfile` for API and worker (same image, different command).
2. CDK v2 app in `infra/` (JavaScript, its own `package.json`).
3. Stack: VPC, ECS Fargate cluster, API service behind an ALB, worker service, Temporal dev server, ElastiCache Redis.
4. `cdk synth` and read the generated template.
5. Template tests with `aws-cdk-lib/assertions`.

**Decision taken:** Temporal runs inside the AWS account as a single dev-server task on ECS. This is a demo setup with in-memory state; production would use Temporal Cloud or a database-backed cluster.

**Done when:** `cdk synth` produces the template without errors and the infrastructure tests pass. No AWS spend yet.

## Session 7 — Observability and load testing

**Concept:** API latency (starting a process) versus process duration; worker metrics; what saturation means.

**Steps**
1. Prometheus + Grafana in the compose file; Temporal SDK and API metrics.
2. Rewrite `loadtest/k6.js` with an arrival-rate scenario and a ramp.
3. Short run (2–3 min); read p50/p95/p99 and error rate.
4. Tuning experiment: the status cache on versus off (optional: worker concurrency).
5. Record the real numbers in `docs/load-test-results.md`.

**Done when:** you have a table of measured results before and after the change, and know where it starts to degrade.

## Session 8 — Deployment and wrap-up

**Steps**
1. `cdk bootstrap` and `cdk deploy` to a real AWS account.
2. Production checklist: ALB healthy, workers connected, Redis reachable.
3. Smoke test against the public URL.
4. `cdk destroy` when finished (ALB, NAT and ElastiCache are billed hourly).
5. Final README: architecture, how to run it, measured results and lessons learned.

**No-cost alternative:** skip the deployment and keep this session to `cdk diff`, a template review and the README.

**Done when:** the process runs end to end on AWS (or the template has been reviewed) and the README describes what was actually built and measured.

---

## Mapping to the README phases

| README phase | Sessions |
| --- | --- |
| 1. Analysis and flow design | 1–2 |
| 2. JavaScript backend with Temporal | 2–5 |
| 3. Infrastructure with CDK and load testing | 6–7 |
| 4. Deployment and measurement | 8 |

## Note on the README figures

The targets (2000 req/s, p99 < 200 ms, 500K processes per month, $1M in savings) come from the project brief. The final README will report the numbers we measure, and savings will be presented as an estimate with its assumptions stated.
