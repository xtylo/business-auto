// Express application. It is exported without listening on a port so that
// tests can import it directly (see server.js for the entry point).
// Placeholder from the base project: the real endpoints arrive in session 4.

const express = require('express');
const routes = require('./routes');

const app = express();

app.use(express.json());
app.use('/api', routes);

module.exports = app;
