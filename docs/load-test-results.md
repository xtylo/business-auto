# Load test results

Measured results for this project. Fill in the tables after each run in
[session-07.md](session-07.md). Numbers describe **this machine**, with the load generator,
the API, the worker, Temporal and Redis all sharing its CPU. They are not a prediction for AWS.

## Environment

| | |
| --- | --- |
| Date | 2026-11-12 |
| Machine (CPU, cores, RAM) | *to fill in* |
| Docker Desktop resources (CPUs, memory) | *to fill in* |
| Commit | *to fill in* |
| Setup | Dev container (API + worker), Temporal dev server, Redis and k6 as containers on the same machine |

## Targets from the project brief

| Metric | Target |
| --- | --- |
| Throughput | 2000 req/s sustained |
| Latency | p99 < 200 ms |
| Error rate | < 0.1% |
| Saturation point | Degradation from ~3500 req/s |

## 1. Smoke: baseline at low load

`SCENARIO=smoke`: 5 iterations/s for 30 s. One iteration is two HTTP requests (start, approve)
and one whole workflow.

| Metric | Result |
| --- | --- |
| Iterations | 150 (5.0/s) |
| HTTP requests | 300 (10.0/s) |
| Latency median | 5.94 ms |
| Latency p95 | 9.5 ms |
| Latency p99 | 14.37 ms |
| Latency max | 45.11 ms |
| Error rate | 0.00% |
| Checks passed | 100% (300 of 300) |
| Dropped iterations | 0 |

Both brief thresholds held: p99 < 200 ms and error rate < 0.1%.

## 2. Ramp: start and approve processes

`SCENARIO=ramp`: arrival rate climbing 10 → 25 → 50 → 100 → 200 → 400 iterations/s, 30 s per
step, 2 min 30 s in total.

### Whole run (k6 summary)

| Metric | Result |
| --- | --- |
| Iterations scheduled | 17,398 |
| Iterations completed | 14,042 (87.9/s on average) |
| Iterations dropped | 3,356 (19% of scheduled) |
| HTTP requests | 28,084 (175.7/s on average) |
| Latency median | 643 ms |
| Latency p95 | 6.54 s |
| Latency p99 | 6.92 s |
| Latency max | 6.99 s |
| Error rate | 0.00% (0 of 28,084) |
| Checks passed | 100% (28,084 of 28,084) |
| Virtual users | Reached the 2,000 ceiling at 2 min 23 s, during the last step |

Threshold `p99 < 200 ms`: **crossed** (6.92 s). Threshold `error rate < 0.1%`: held.

These figures cover the whole ramp, so the low-load steps and the overloaded ones are averaged
together. Per-step values come from the Grafana latency panel:

| Step (iterations/s) | Requests/s | p50 | p95 | p99 | Notes |
| --- | --- | --- | --- | --- | --- |
| 25 | 50 | | | | |
| 50 | 100 | | | | |
| 100 | 200 | | | | |
| 200 | 400 | | | | |
| 400 | 800 | | | | |

### What the dashboard showed

- API latency stayed low for most of the ramp and then rose steeply to more than 2 s in the
  final part of the run, p50 included.
- No 5xx responses at any point.
- Worker execution slots were never exhausted: roughly 90 of 100 activity slots and 30 of 40
  workflow-task slots stayed free.
- The p95 wait in the workflow task queue hit the top bucket of its histogram, so the real
  value is "at least" what the panel shows.
- After k6 finished, the worker kept completing about 25 workflows per second for several
  minutes until the backlog was gone. The run was still draining five minutes after the end.

### Reading

- **Saturation point:** in the last two steps (200 to 400 iterations/s). The run as a whole
  sustained about 88 iterations/s (176 requests/s), far below the 2,000 requests/s target.
- **How it degraded:** in response time, not in correctness. Every accepted request returned
  202, nothing was rejected, and every started process was eventually completed.
- **Where the limit was:** not in the worker's slots, which stayed mostly free. The evidence
  points at the single-process Temporal dev server or at the CPU shared by every component on
  one machine. The data here cannot tell those two apart.
- **Process throughput versus API throughput:** the API accepted work faster than the system
  finished it (about 25 workflows/s). The difference queued inside Temporal and was not lost.

## 3. Tuning: status cache on versus off

`SCENARIO=reads`: 200 status reads per second for 60 s, spread over 20 processes that stay
waiting for approval. Same rate for both runs; the only difference is `STATUS_CACHE=off`.

| | Cache on | Cache off | Change |
| --- | --- | --- | --- |
| Rate requested (req/s) | 200 | 200 | |
| Rate achieved (req/s) | 199 | 199 | same |
| Reads completed | 12,001 | 12,001 | same |
| Successful reads (HTTP 200) | 100% | 100% | same |
| Latency median | 0.84 ms | 11.45 ms | 13.6x slower |
| Latency p95 | 9.86 ms | 32.45 ms | 3.3x slower |
| Latency p99 | 13.28 ms | 61.54 ms | 4.6x slower |
| Latency max | 1.91 s | 1.77 s | |
| Cache hit ratio | 94.79% | 0% | |
| Reads that reached Temporal | about 625 (5%) | 12,001 (100%) | 19x more |
| Virtual users needed at peak | 2 | 10 | 5x more |
| Dropped iterations | 0 | 0 | same |

### What changed and why

- **Both configurations handled 200 reads per second** with no errors and inside the
  `p99 < 200 ms` target. On this machine, at this rate, the cache is not what makes the
  system work.
- **The cache makes the typical read about 14 times faster** (median 0.84 ms versus 11.45 ms).
  A cached read is one Redis `GET`. An uncached read is two calls to Temporal, one of which
  is a query that a worker answers by running the workflow code.
- **The larger effect is on what sits behind the API.** A 2-second cache on 20 processes cut
  the reads that reach Temporal and the worker from 12,001 to about 625. That capacity stays
  available for running workflows.
- **p50 improved much more than p99.** With the cache on, the slowest reads are the 5% that
  miss, so the tail is still set by Temporal. A cache moves the median far more than the tail.

### An invalid run, and what it showed

The first cache-off attempt failed on every one of its 3,178 reads, each after about 40
seconds, with 8,036 iterations dropped. The cause was not load: **the worker was not
running**. A status read with the cache off is a Temporal query, and a query needs a worker.
That run was discarded and repeated; the table above is the repeat.

It still showed two things worth keeping:

- With the cache **on**, 95% of status reads would have kept working through that same worker
  outage, because they are answered from Redis. The cache also softens a worker outage for reads.
- A missing dependency under an open load model does not fail fast. Requests piled up to the
  2,000 virtual-user ceiling and each waited tens of seconds. A short query timeout in the
  API would turn that into a quick `503`.

## 4. Optional tuning: worker concurrency

`SCENARIO=ramp` or `smoke`, comparing `WORKER_MAX_ACTIVITIES=5` with the default.

| | Limited (5) | Default |
| --- | --- | --- |
| Workflows finished per second | | |
| Activity queue wait p95 | | |
| Free activity slots at peak | | |

## 5. On AWS

Run on 2026-11-13 against the deployed stack in `us-west-2` (Oregon), through the public load
balancer. k6 ran on the development machine in Sonora, Mexico, so **every figure includes the
internet round trip** between the two. API: 2 Fargate tasks (0.25 vCPU, 512 MB each). Worker:
1 task. Temporal: 1 dev-server task. Redis: one `cache.t4g.micro` node.

| | Smoke (5 processes/s, 30 s) | Reads (200 req/s, 60 s, cache on) |
| --- | --- | --- |
| HTTP requests | 300 (9.9/s) | 12,020 (193.6/s) |
| Latency median | 89.49 ms | 81.18 ms |
| Latency p95 | 164.41 ms | 119.27 ms |
| Latency p99 | 196.28 ms | 272.42 ms |
| Latency max | 256.72 ms | 696.96 ms |
| Failed requests | 0 of 300 | 1 of 12,020 (0.008%) |
| Cache hit ratio | n/a | 93.95% |
| Dropped iterations | 0 | 0 |
| Virtual users at peak | 2 | 49 |

Against the brief's thresholds: error rate under 0.1% held in both runs. p99 under 200 ms
held in the smoke run by a narrow margin (196 ms) and was missed in the reads run (272 ms).

### Reading

- **Most of the latency is distance, not processing.** The same cached read has a median of
  0.84 ms locally and 81 ms from Sonora to Oregon. The difference is the network path, which
  these runs cannot separate from server time. Measuring from inside the region, or reading
  the load balancer's own target response time, would isolate it.
- **Redis worked across both API tasks.** A 94% hit ratio with two tasks behind the load
  balancer is only possible with a shared cache: each task served entries the other one wrote.
- **One request in 12,020 failed.** Its cause was not investigated before the stack was
  destroyed. It is inside the error-rate target, and is recorded here rather than explained.
- **Not run on AWS:** the ramp scenario and the cache-off comparison. The saturation point of
  this deployment is unknown.

## Conclusions

- **Against the targets.** At low load the API is far inside the latency target (p99 of 14 ms
  against 200 ms) with no errors. The throughput target of 2,000 requests/s was not approached:
  the ramp sustained about 176 requests/s on average and latency broke down in its last steps.
  The error-rate target held in every valid run: no request was rejected or lost.
- **Bottleneck on this machine.** Not the worker's execution slots, which stayed mostly free
  during the ramp. The limit is either the single-process Temporal dev server or the CPU that
  the load generator, API, worker, Temporal and Redis all share. These runs cannot separate
  the two.
- **Behaviour under overload.** The system slowed down instead of failing: work accepted by
  the API queued inside Temporal and was completed minutes later at about 25 workflows/s.
- **Value of the cache.** About 14x on median read latency and a 19x reduction in read
  traffic reaching Temporal, at 200 reads/s.
- **What I would change first on AWS.** Replace the single in-memory Temporal task with
  Temporal Cloud or a database-backed cluster; add a timeout to status queries so a missing
  worker fails fast; measure from inside the region to separate network time from server
  time; then find the deployment's saturation point with the ramp scenario and scale the API
  and the worker independently from what it shows.

## Not measured

- Per-step latency during the ramp (only whole-run figures were recorded).
- Worker concurrency (section 4).
- The saturation point on AWS, and server-side latency without the internet path.
- The business figures in the brief (500K processes per month, 1M USD per year saved).
