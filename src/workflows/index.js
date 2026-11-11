// Entry point for the workflow bundle. Every workflow the worker can run
// must be exported from this file.

const { helloProcess } = require('./hello-process');
const { invoiceApproval } = require('./invoice-approval');

module.exports = { helloProcess, invoiceApproval };
