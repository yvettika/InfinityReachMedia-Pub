'use strict';

/**
 * Runs every suite. Kept as separate processes because the discovery tests
 * set PLACES_ENDPOINT and a fake API key in the environment, and those must
 * not leak into the research tests — which are supposed to run with no Places
 * access at all, the same way a fresh machine does.
 *
 *   node intel/test/all.js
 */

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = ['run-tests.js', 'discover-tests.js', 'sync-tests.js'];
let failures = 0;

for (const suite of SUITES) {
  const res = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    stdio: 'inherit',
    env: { ...process.env, PLACES_ENDPOINT: undefined, GOOGLE_PLACES_API_KEY: undefined, GHL_ENDPOINT: undefined, GHL_API_KEY: undefined },
  });
  if (res.status !== 0) failures++;
}

process.exit(failures ? 1 : 0);
