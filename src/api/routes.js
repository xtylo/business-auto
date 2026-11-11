// API routes that will interact with Temporal.
// Placeholder from the base project: implemented in session 4.

const express = require('express');

const router = express.Router();

router.post('/start-process', (req, res) => {
  // TODO (session 4): start a workflow through the Temporal client.
  res.send('Process started');
});

module.exports = router;
