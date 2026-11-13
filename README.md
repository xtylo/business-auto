# Business Process Automation Platform

A platform that automates business processes using durable workflows.
Built with JavaScript (Node.js), Temporal, Redis and AWS CDK.

> **Status:** work in progress. Session 7 of 8 in progress. See [PLAN.md](PLAN.md) for the roadmap.
> The "Project brief" section below is the original set of requirements. Its target figures
> are goals, not measured results; the final README will report what was actually measured.

## Getting started

### Option A: dev container (recommended)

Requirements: Docker Desktop, VS Code with the Dev Containers extension.

1. Open the folder in VS Code and run **Dev Containers: Reopen in Container**.
2. Temporal and Redis start automatically, and `npm install` runs inside the container.

```bash
npm run worker           # terminal 1: start a worker
npm run start:invoice    # terminal 2: start an invoice approval workflow, then follow the printed commands
```

### Option B: directly on the host

Requirements: Node.js 20 or later (22 LTS recommended), Docker Desktop.

```bash
npm install
npm run infra:up         # start Temporal and Redis in Docker
npm run worker           # terminal 1
npm run start:invoice    # terminal 2
```

Temporal Web UI in both cases: http://localhost:8233

Metrics: Prometheus at http://localhost:9090 and Grafana at http://localhost:3001 (dashboard "Business Auto").
Load tests: see [docs/session-07.md](docs/session-07.md).

| Script | What it does |
| --- | --- |
| `npm run worker` | Starts a Temporal worker |
| `npm run start:invoice -- <scenario> [timeoutSeconds]` | Starts `invoiceApproval`. Scenarios: `happy`, `flaky`, `exhausted`, `compensate`, `invalid` |
| `npm run invoice -- <status\|approve\|reject\|result> <workflowId>` | Queries or signals a running invoice workflow |
| `npm run start:hello -- <name> <pauseSeconds>` | Starts the `helloProcess` workflow |
| `npm test` | Runs all tests. `npm run test:unit` skips the workflow tests, which need to download a test server once |
| `npm run cdk:synth` / `cdk:test` / `cdk:diff` | AWS infrastructure in `infra/`: generate the CloudFormation template, run the template tests, compare with what is deployed |
| `npm run docker:build` | Host only: builds the production image |
| `npm run api` | Starts the HTTP API on port 3000. Endpoints and examples: [docs/session-04.md](docs/session-04.md) |
| `npm run infra:up` / `infra:down` / `infra:logs` | Host only: manage Temporal and Redis with Docker Compose. History is in memory and is erased on stop |

## Repository layout

```
src/
  workflows/     Orchestration logic. Deterministic, runs in Temporal's sandbox
  activities/    Steps with side effects (HTTP, database, e-mail)
  api/           Express application (app.js, routes.js, store.js, server.js)
  scripts/       Small command-line starters
  worker.js      Process that executes workflows and activities
  client.js      Temporal client factory
  redis.js       Redis connection factory
  config.js      Configuration from environment variables
test/            Activity, API and workflow tests
docs/            Session notes
.devcontainer/   Development container definition
infra/           AWS infrastructure (CDK v2): network, ECS services, load balancer, Redis
Dockerfile       Production image, shared by the API and the worker
observability/   Prometheus and Grafana configuration
loadtest/        k6 load test (scenarios: smoke, ramp, reads)
```

---

## Project brief

**Problem:** Companies face high costs and delays caused by slow manual processes and a lack of automation.

**Solution:** An automation platform that reduces manual work, built with JavaScript, Temporal and AWS CDK.

**Target impact:** Automate 500K processes per month and reduce operating costs by $1M per year.

**Technologies:** JavaScript, Temporal, AWS CDK, ELB, Redis

**New technologies to learn:** Temporal, AWS CDK

### Phases

1. Phase 1: Business process analysis and automation flow design
2. Phase 2: Backend development in JavaScript with Temporal integration
3. Phase 3: Infrastructure setup with AWS CDK and load testing
4. Phase 4: Production deployment and measurement of operating cost savings

### Overview

This project builds a platform for automating business processes using Temporal and AWS CDK in a cloud environment. Temporal coordinates distributed, asynchronous tasks, which is key for complex business processes that need orchestration. AWS CDK provides infrastructure as code, so AWS resources are defined and deployed programmatically and repeatably.

The design target is up to 500,000 automated processes per month, significantly reducing the time and cost of manual work.

Key concepts covered: workflow orchestration with Temporal, infrastructure as code with AWS CDK, and running cloud services such as ELB and Redis on AWS.

### Architecture

```
[Client] --> [API Gateway] --> [ELB] --> [Backend Service (Node.js + Temporal)] --> [Redis Cache]
                                          |
                                          v
                                [Temporal Workers]
```

- **Client**: User interface or system that starts processes.
- **API Gateway**: Handles incoming requests and routes them to the load balancer.
- **ELB (Elastic Load Balancer)**: Distributes traffic across backend service instances.
- **Backend Service**: Node.js application that coordinates tasks using Temporal.
- **Temporal Workers**: Execute the activities defined in the workflows.
- **Redis Cache**: Stores temporary data to improve performance.

### Local environment

The original brief proposed LocalStack to emulate ELB and Redis. This project instead runs
Temporal and Redis as real containers with Docker Compose, and validates the AWS infrastructure
with `cdk synth` and template tests (see "Adjustments to the base project" in [PLAN.md](PLAN.md)).

### Cloud deployment

1. Configure AWS credentials in your environment.
2. Deploy with AWS CDK:
   ```
   cdk deploy
   ```
3. Verify that all resources were created in the AWS console.
4. Production checklist:
   - [ ] The load balancer is healthy.
   - [ ] Temporal workers are active.
   - [ ] Redis is connected and working.

### Load testing

1. Tool: k6
2. Load scenario: 1000 VUs for 10 minutes.
3. Run with:
   ```
   k6 run loadtest/k6.js
   ```
4. Analyze the results with Grafana and Prometheus to find bottlenecks.

### Target metrics

| Metric | Target | How to measure |
| --- | --- | --- |
| Target QPS / RPS | 2000 req/s sustained | Prometheus request-rate metrics |
| Latency p50 / p95 / p99 | p99 < 200 ms | Prometheus and Grafana under load |
| Error rate | < 0.1% | HTTP errors and workflow failures in Prometheus |
| Saturation point | Degradation from ~3500 req/s | Performance and latency under increasing load |

### Testing (unit / integration)

Unit test example with Jest:

```javascript
// test/workflows.test.js
const { startWorkflow } = require('../src/workflows');

test('should start workflow successfully', async () => {
  const result = await startWorkflow();
  expect(result).toBeDefined();
});
```

Integration test example:

```javascript
// test/integration.test.js
const request = require('supertest');
const app = require('../src/index');

test('POST /api/start-process should return 200', async () => {
  const response = await request(app).post('/api/start-process');
  expect(response.statusCode).toBe(200);
});
```

These are the examples from the brief. The real tests are written in session 5.

### Technical challenges

**Distributed workflow orchestration.** Coordinating many distributed tasks is hard because failures must be handled and consistency preserved. Temporal handles automatic re-execution; activities are written so they can be retried without corrupting global state.

**Infrastructure as code with AWS CDK.** Defining infrastructure in code requires understanding the underlying AWS resources. CDK lets you write it in a familiar programming language, using constructs to declare resources.

**System scalability.** The system must absorb load increases without degrading. ELB distributes the load and Redis caches responses, reducing pressure on backend services.

### Learning path

**Temporal**

1. Learn the basic concepts from the official documentation.
2. Implement a simple workflow in a test project.
3. Integrate Temporal into the automation project.
4. Experiment with retries and error handling.
5. Evaluate performance under load.

- https://docs.temporal.io
- https://github.com/temporalio/samples-typescript

**AWS CDK**

1. Learn the fundamentals from the official documentation.
2. Practice with simple resources such as S3 and Lambda.
3. Define the whole project infrastructure with CDK.
4. Experiment with different configurations and deployments.
5. Automate deployment and infrastructure management.

- https://docs.aws.amazon.com/cdk/v2/guide/home.html
- https://github.com/aws/aws-cdk
