# Session 1 — Temporal: first workflow running

## The four pieces

| Piece | What it is | Where it lives here | Closest .NET / Azure idea |
| --- | --- | --- | --- |
| **Workflow** | The orchestration logic: which steps run, in what order, what happens on failure | `src/workflows/hello-process.js` | Durable Functions orchestrator |
| **Activity** | One step with side effects: an HTTP call, a database write, an e-mail | `src/activities/hello.js` | Durable Functions activity |
| **Worker** | A process of yours that polls the server for tasks and runs workflow and activity code | `src/worker.js` | The Functions host |
| **Task queue** | A named queue on the server. Starters put work in, workers take work out | `business-processes` in `src/config.js` | A queue name, but managed for you |

The **Temporal server** (the Docker container) never runs your code. It stores each workflow's
event history and hands out tasks. That history is what makes workflows durable.

## Why workflow code must be deterministic

When a worker picks up a workflow that was already in progress, it does not restore a memory
snapshot. It runs the workflow function again from the top and feeds it the recorded history:
"`greet` already returned `Hello, Ana!`", "the timer already fired". The function must reach
the same point by making the same decisions, so it cannot depend on anything that changes
between runs: the clock, random numbers, network responses.

Rule of thumb: **decisions in the workflow, effects in activities**.

## Steps

### 1. Install and start the infrastructure

```bash
npm install
npm run infra:up
```

Open http://localhost:8233. You should see the Temporal Web UI with no workflows.

### 2. Start a worker (terminal 1)

```bash
npm run worker
```

Expected: `Worker listening on task queue "business-processes" ...`

### 3. Start a workflow (terminal 2)

```bash
npm run start:hello -- Ana 20
```

Expected, after about 20 seconds: `Result: { greeting: 'Hello, Ana!', completion: '...' }`

### 4. Read the event history

Open the workflow in the Web UI and look at the **Event History** tab. Map each group of
events to a line of `helloProcess`:

| Events | Line of code |
| --- | --- |
| `WorkflowExecutionStarted` | `client.workflow.start(...)` in the starter script |
| `ActivityTaskScheduled` → `Started` → `Completed` | `await greet(name)` |
| `TimerStarted` → `TimerFired` | `await sleep(...)` |
| `ActivityTaskScheduled` → `Started` → `Completed` | `await recordCompletion(name)` |
| `WorkflowExecutionCompleted` | `return { greeting, completion }` |

The `WorkflowTask*` events in between are the moments when a worker ran your workflow function
to decide what to do next.

### 5. Experiment: kill the worker mid-process

1. Start a long one: `npm run start:hello -- Durable 60`
2. While it waits, stop the worker with Ctrl+C in terminal 1.
3. Look at the Web UI: the workflow is still **Running**. Wait until the 60 seconds have passed.
4. Start the worker again: `npm run worker`
5. The workflow finishes. `greet` was **not** executed a second time: its result came from history.

### 6. Experiment: start with no worker running

1. Stop the worker.
2. `npm run start:hello -- Queued 5`
3. The workflow starts and stays **Running**: the task waits in the queue.
4. Start the worker and it completes.

This is the decoupling you would otherwise build with a message broker and an outbox.

## Check yourself

- Why would `Date.now()` inside `helloProcess` be a bug?
- In experiment 5, how did the restarted worker know that `greet` had already run?
- What would happen if the starter script and the worker used different task queue names?
- Where would you put a call to a payment provider: workflow or activity? Why?

## Done when

- [ ] A `helloProcess` execution shows **Completed** in the Web UI.
- [ ] You can explain what each event in its history corresponds to.
- [ ] Experiment 5 worked: the workflow survived the worker being stopped.
- [ ] First commit created.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Connection refused ... 7233` | Temporal is not running. `npm run infra:up`, then `docker compose ps` |
| Workflow stays **Running** forever | No worker is running, or the task queue names differ |
| Port 7233, 8233 or 6379 already in use | Another process uses it. Stop it or change the left side of the port mapping in `docker-compose.yml` |
| Web UI is empty after a restart | Expected: the dev server keeps history in memory |
