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
waiting for approval. Same rate for both runs.

| | Cache on | Cache off (`STATUS_CACHE=off`) |
| --- | --- | --- |
| Rate requested (req/s) | 200 | 200 |
| Rate achieved (req/s) | 199 | 35 |
| Reads completed | 12,001 | 3,178 |
| Successful reads (HTTP 200) | 100% | 0% |
| Latency median | 0.84 ms | 39.5 s |
| Latency p95 | 9.86 ms | 42.1 s |
| Latency p99 | 13.28 ms | 43.4 s |
| Latency max | 1.91 s | 60 s (request timeout) |
| Cache hit ratio | 94.79% | 0% |
| Dropped iterations | 0 | 8,036 |
| Virtual users | 2 at most | Reached the 2,000 ceiling after 19 s |

### Cache on: valid result

With a 2-second cache on a running workflow, 95% of the reads never reached Temporal. Redis
answered them in under a millisecond at the median, and 200 requests/s needed at most two
virtual users. The remaining 5% (about 10 reads per second) went to Temporal and were also
fast: the whole run stayed at p99 = 13 ms.

### Cache off: not yet a valid measurement

**Every** read failed, including the very first ones, and each took about 40 seconds to fail.
A system that is merely overloaded normally serves the first requests and then degrades. A
100% failure rate from the start fits a different explanation at least as well: no worker was
answering queries during this run (a status read with the cache off always needs a worker).

Until that is ruled out, this column shows what happened but does not measure the cost of
running without the cache. To settle it:

1. Confirm the worker is running, then read one process by hand with the cache off. A fast
   `200` means the worker is fine and the collapse was real overload.
2. Repeat the scenario at lower rates (`-e RATE=20`, `50`, `100`) to find where the
   no-cache configuration actually breaks.

| Rate (req/s), cache off | Successful | p50 | p95 | p99 | Dropped iterations |
| --- | --- | --- | --- | --- | --- |
| 20 | | | | | |
| 50 | | | | | |
| 100 | | | | | |

**What changed and why:** *to complete after the re-run.*

## 4. Optional tuning: worker concurrency

`SCENARIO=ramp` or `smoke`, comparing `WORKER_MAX_ACTIVITIES=5` with the default.

| | Limited (5) | Default |
| --- | --- | --- |
| Workflows finished per second | | |
| Activity queue wait p95 | | |
| Free activity slots at peak | | |

## Conclusions

- Against the targets:
- Bottleneck on this machine:
- What I would change first on AWS:
