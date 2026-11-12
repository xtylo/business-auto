# Session 5 — Testing

So far every check was done by hand: run a scenario, read the terminal, look at the Web UI.
This session turns those checks into tests that run in seconds and need no manual steps.

## Three kinds of test, three levels of realism

| Tests | What is real | What is faked | Needs | Speed |
| --- | --- | --- | --- | --- |
| **Activities** (`test/activities/`) | The activity functions | Temporal's activity context (attempt number) | Nothing | Milliseconds |
| **API** (`test/api/`) | Express app, routes, Redis logic | Temporal client, Redis | Nothing | Milliseconds |
| **Workflows** (`test/workflows/`) | Workflow code, Temporal server, worker, signals, timers, retries | Activities | Test server (downloaded once) | Seconds |

Each level fakes the layer *next to* the one under test and nothing else. The workflow tests
are the interesting ones: they are closer to integration tests than unit tests, yet they stay
fast because of time skipping.

## Concepts

### Time skipping

`TestWorkflowEnvironment.createTimeSkipping()` starts an in-memory Temporal server whose
clock can jump. When the test is only waiting for a workflow result and the workflow is only
waiting for a timer, the server moves the clock forward to the timer instead of waiting.

The workflow tests use an approval timeout of **5 days**. The expiry test waits for two of
those and finishes in well under a second. Nothing in the workflow code knows it is being
tested: there is no injected clock and no "test mode" flag.

In .NET terms: this is `FakeTimeProvider`, but applied to a whole orchestration engine and
without having to pass a `TimeProvider` through your code.

`testEnv.sleep(ms)` moves the clock by an exact amount, for tests that need to stop in the
middle: "six days in, the status must be ESCALATED".

### Mocking activities, not the workflow

The worker in each test is created with `activities: mockActivities(...)`: the same names as
the real activities, implemented as `jest.fn()`. That gives each test two powers:

- **Decide what the outside world does**: "the ledger is down for good".
- **Assert what the workflow asked for**: "`revertPayment` was called once, with this payment".

To make an activity fail, tests throw a **non-retryable** failure. With a normal error the
retry policy would run first, and the test would be checking retries instead of compensation.
One test does use a normal error on purpose, to check exactly that.

### Dependency injection pays off

`createApp({ temporalClient, redis })` receives its dependencies. Production passes real
connections (`src/api/server.js`); tests pass the fakes in `test/helpers/`. No mocking library
has to intercept `require`, and one test simulates a Redis outage with a single call:
`redis.goDown()`.

## Steps

All commands run inside the dev container.

### 0. Install the new development dependencies

```bash
npm install
```

### 1. Run the fast tests

```bash
npm run test:unit
```

Expected: 2 suites, 36 tests passed, in about a second. Open `test/api/api.test.js` and find
the tests that correspond to what you did by hand with `curl` in session 4: same key twice,
same invoice with another key, cache MISS then HIT, Redis down.

### 2. Run the workflow tests

```bash
npm run test:workflows
```

The first run downloads the test server, so it takes longer. Expected: 10 passed, 1 todo.

Look at the time of `with no answer the request escalates, then expires`: ten days of
waiting, done in milliseconds.

### 3. Break something on purpose

A test suite is worth what it catches. Make each change, run `npm test`, see which test
fails, then undo it.

| Change in `src/workflows/invoice-approval.js` | Test that should fail |
| --- | --- |
| Delete the line `if (decision) return;` in the `reject` handler | `the first decision wins; a later one is ignored` |
| Delete `compensations.unshift(() => revertPayment(invoice, payment));` | `when the ledger fails for good, the payment is reverted...` |
| Replace the body of `notifyBestEffort` with a plain `await notify(...)` and `return true` | `a notification that cannot be sent does not undo the payment` |

### 4. Write a test yourself

At the end of `test/workflows/invoice-approval.test.js` there is a `test.todo`:

> an approval sent while the invoice is still being validated is not lost

Turn it into a real test. Hints:

- Make `validateInvoice` slow: a mock that awaits a promise you resolve later, or simply
  `await new Promise((resolve) => setTimeout(resolve, 500))`.
- Send the `approve` signal right after the workflow starts, before validation finishes.
- The result must be `PAID`.

It passes because the signal handlers are registered before the first `await` in the
workflow. Move the `setHandler` calls below `await validateInvoice(invoice)` and run it again
to see the difference.

### 5. Continuous integration

`.github/workflows/ci.yml` runs both test commands on every push and pull request. It takes
effect when the repository is pushed to GitHub; nothing to do locally.

## Useful commands

```bash
npm test                              # everything
npm run test:unit                     # activities + API, no server
npm run test:workflows                # workflow tests
npx jest -t "first decision"          # only tests whose name matches
TEST_LOG_LEVEL=INFO npm run test:workflows   # show the SDK logs while debugging
```

## Check yourself

- Why do the workflow tests mock the activities but not the Temporal server?
- A workflow test fails only when it uses a normal `Error` and passes with a non-retryable
  failure. What does that tell you about what the test was really measuring?
- The API tests never start a workflow for real. Which bug could they miss, and which test
  level would catch it?
- How would you test "the timeout is 5 days in production" without waiting 5 days and without
  time skipping? What would you have to change in the code?

## Done when

- [ ] `npm test` passes: 3 suites, 47 tests once the `test.todo` is written.
- [ ] You broke the workflow three ways and each time a test caught it.
- [ ] You replaced the `test.todo` with a passing test.
- [ ] Commit created: `Session 5: activity, API and workflow tests`

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Cannot find module 'jest'` or `supertest` | Run `npm install` inside the container |
| `Failed to start ephemeral server: failed to download...` | The container could not reach `temporal.download`. Check the network or proxy and run again; the download happens once |
| Workflow tests hang until the 60 s timeout | Usually an activity the workflow calls is missing from the mocks. Check the worker error with `TEST_LOG_LEVEL=INFO` |
| `Jest did not exit one second after the test run` | A test failed before the worker shut down. Fix the failing test first |
| Tests pass alone but fail together | Shared state between tests. Each test must build its own mocks and use its own task queue, as `runScenario` does |
