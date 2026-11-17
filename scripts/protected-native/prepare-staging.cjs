'use strict';
const { context } = require('./common.cjs');
const { releaseFor } = require('./finish.cjs');
// A single prerequisite job creates the output draft before the native jobs
// start. Parallel finishers only read it; they cannot race draft creation.
releaseFor(context(), process.env.GH_TOKEN, true).then(() => {
  console.log('Protected native staging is ready.');
}).catch(() => {
  console.error('Protected native staging could not be prepared.'); process.exitCode = 1;
});
