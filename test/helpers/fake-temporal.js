// In-memory stand-in for the parts of the Temporal client the API uses.
//
// API tests check HTTP behaviour: status codes, headers, what gets cached.
// The workflow itself is tested for real in test/workflows/.

const { WorkflowNotFoundError, WorkflowExecutionAlreadyStartedError } = require('@temporalio/client');

function createFakeTemporalClient() {
  const workflows = new Map();
  const calls = { start: 0, query: 0, signal: 0 };

  function find(workflowId) {
    const workflow = workflows.get(workflowId);
    if (!workflow) throw new WorkflowNotFoundError('workflow not found', workflowId, undefined);
    return workflow;
  }

  return {
    // Test controls
    workflows,
    calls,
    /** Forces a workflow into a closed state, as if it had failed or completed. */
    close(workflowId, execution, status) {
      const workflow = find(workflowId);
      workflow.execution = execution;
      workflow.state.status = status;
    },

    workflow: {
      async start(workflowType, options) {
        calls.start++;
        const existing = workflows.get(options.workflowId);
        // Mirrors ALLOW_DUPLICATE_FAILED_ONLY: only a failed workflow may be started again.
        if (existing && existing.execution !== 'FAILED') {
          throw new WorkflowExecutionAlreadyStartedError(
            'Workflow execution already started',
            options.workflowId,
            workflowType
          );
        }
        workflows.set(options.workflowId, {
          options,
          execution: 'RUNNING',
          state: { invoiceId: options.args[0].id, status: 'AWAITING_APPROVAL', decision: null },
        });
        return { workflowId: options.workflowId };
      },

      getHandle(workflowId) {
        return {
          async describe() {
            const workflow = find(workflowId);
            return {
              status: { name: workflow.execution },
              startTime: new Date('2026-01-01T00:00:00Z'),
              closeTime: workflow.execution === 'RUNNING' ? undefined : new Date('2026-01-01T00:01:00Z'),
            };
          },
          async query() {
            calls.query++;
            return { ...find(workflowId).state };
          },
          async signal(signalName, payload) {
            calls.signal++;
            const workflow = find(workflowId);
            workflow.execution = 'COMPLETED';
            workflow.state.status = signalName === 'approve' ? 'PAID' : 'REJECTED';
            workflow.state.decision = { approved: signalName === 'approve', ...payload };
          },
        };
      },
    },
  };
}

module.exports = { createFakeTemporalClient };
