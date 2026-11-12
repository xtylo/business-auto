// HTTP routes. Each one translates an HTTP request into a Temporal operation:
//
//   POST /api/start-process          -> start a workflow
//   GET  /api/process/:id            -> query a workflow
//   POST /api/process/:id/approve    -> signal a workflow
//   POST /api/process/:id/reject     -> signal a workflow
//
// The API holds no process state of its own. Temporal is the source of truth.

const express = require('express');
const { WorkflowNotFoundError, WorkflowExecutionAlreadyStartedError } = require('@temporalio/client');
const config = require('../config');

// How long a status response may be served from Redis.
const RUNNING_STATUS_TTL_SECONDS = 2; // changes at any moment: keep it short
const CLOSED_STATUS_TTL_SECONDS = 60 * 60; // a closed workflow never changes again

/**
 * @param {object} deps
 * @param {import('@temporalio/client').Client} deps.temporalClient
 * @param {ReturnType<import('./store').createStore>} deps.store
 */
function createRoutes({ temporalClient, store }) {
  const router = express.Router();

  // ---- Start a process -------------------------------------------------------
  router.post('/start-process', async (req, res) => {
    const { invoice, options = {} } = req.body || {};

    const problems = validateStartRequest(invoice, options);
    if (problems.length > 0) {
      return res.status(400).json({ error: 'Invalid request', details: problems });
    }

    // Business key as workflow ID: the same invoice always maps to the same workflow.
    const workflowId = `invoice-${invoice.id}`;
    const idempotencyKey = req.get('Idempotency-Key');

    // Layer 1 (Redis): the client repeated the SAME request, for example after a
    // network timeout. Answer as if it were the first time, without starting anything.
    if (idempotencyKey) {
      const claim = await store.claimIdempotencyKey(idempotencyKey, workflowId);
      if (!claim.claimed) {
        return res.status(200).json({ workflowId: claim.workflowId, duplicate: true });
      }
    }

    try {
      await temporalClient.workflow.start('invoiceApproval', {
        taskQueue: config.taskQueue,
        workflowId,
        args: [invoice, options],
        // Layer 2 (Temporal): a DIFFERENT request for an invoice that already has
        // a workflow. A running or completed invoice cannot be started again;
        // one whose workflow failed can be resubmitted.
        workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
      });
    } catch (err) {
      if (idempotencyKey) await store.releaseIdempotencyKey(idempotencyKey);

      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        return res.status(409).json({ error: 'A process for this invoice already exists', workflowId });
      }
      throw err;
    }

    // 202 Accepted: the process was started, not finished. It may run for days.
    res.status(202).location(`/api/process/${workflowId}`).json({ workflowId, duplicate: false });
  });

  // ---- Read the state of a process -------------------------------------------
  router.get('/process/:id', async (req, res) => {
    const workflowId = req.params.id;

    const cached = await store.getCachedStatus(workflowId);
    if (cached) {
      return res.set('X-Cache', 'HIT').json(cached);
    }

    const handle = temporalClient.workflow.getHandle(workflowId);

    // describe(): what Temporal knows about the execution (RUNNING, COMPLETED, FAILED...).
    // query():    what the workflow code itself reports (AWAITING_APPROVAL, PAID...).
    const description = await handle.describe();
    const state = await handle.query('status');

    const body = {
      workflowId,
      execution: description.status.name,
      startedAt: description.startTime,
      closedAt: description.closeTime || null,
      ...state,
    };

    const isRunning = description.status.name === 'RUNNING';
    await store.cacheStatus(
      workflowId,
      body,
      isRunning ? RUNNING_STATUS_TTL_SECONDS : CLOSED_STATUS_TTL_SECONDS
    );

    res.set('X-Cache', 'MISS').json(body);
  });

  // ---- Send a decision -------------------------------------------------------
  router.post('/process/:id/approve', (req, res) => sendDecision(req, res, 'approve'));
  router.post('/process/:id/reject', (req, res) => sendDecision(req, res, 'reject'));

  async function sendDecision(req, res, signalName) {
    const workflowId = req.params.id;
    const { approver, comment, reason } = req.body || {};

    if (!approver || typeof approver !== 'string') {
      return res.status(400).json({ error: 'Invalid request', details: ['approver is required'] });
    }

    const handle = temporalClient.workflow.getHandle(workflowId);

    // A closed workflow cannot receive signals. Checking first lets the API say
    // "too late" (409) instead of the misleading "not found" (404).
    const description = await handle.describe();
    if (description.status.name !== 'RUNNING') {
      return res.status(409).json({
        error: 'The process has already finished',
        execution: description.status.name,
      });
    }

    const payload = signalName === 'approve' ? { approver, comment } : { approver, reason };
    await handle.signal(signalName, payload);
    await store.invalidateStatus(workflowId);

    // 202: the signal was stored. The workflow reacts on its own time.
    res.status(202).json({ workflowId, signal: signalName, accepted: true });
  }

  return router;
}

function validateStartRequest(invoice, options) {
  const problems = [];

  // Only the shape is checked here, so the workflow ID can be built.
  // Business validation (amount, currency...) belongs to the workflow: that way
  // an invalid invoice leaves a record instead of disappearing as a 400.
  if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) {
    problems.push('invoice is required and must be an object');
  } else if (typeof invoice.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(invoice.id)) {
    problems.push('invoice.id is required: 1-64 letters, digits, dot, dash or underscore');
  }

  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    problems.push('options must be an object');
  } else if (
    options.approvalTimeoutSeconds !== undefined &&
    !(Number.isFinite(options.approvalTimeoutSeconds) && options.approvalTimeoutSeconds > 0)
  ) {
    problems.push('options.approvalTimeoutSeconds must be a number greater than 0');
  }

  return problems;
}

/**
 * Error-handling middleware: turns errors thrown by any route into HTTP responses.
 * Express 5 forwards rejected promises from async handlers here automatically.
 */
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof WorkflowNotFoundError) {
    return res.status(404).json({ error: 'Process not found' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid request', details: ['body is not valid JSON'] });
  }

  console.error('Unhandled error:', err);
  res.status(503).json({ error: 'The process engine is not available right now' });
}

module.exports = { createRoutes, errorHandler };
