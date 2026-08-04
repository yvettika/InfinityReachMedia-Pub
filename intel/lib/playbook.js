'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Loader for the private half of this system.
 *
 * This repo is public. The engine — fetching, detection, the leak model, the
 * brief renderer — is fine to publish. The playbook is not: our objection
 * handling, our industry priors, and which testimonial we deploy against which
 * objection are the parts a competitor would actually want.
 *
 * So those three live in gitignored files, and a committed `.example` sibling
 * holds neutral placeholder content. This resolver prefers the real file and
 * falls back to the example, which means:
 *
 *   - on our machines, everything runs against the real playbook
 *   - on a fresh clone, everything still runs, just with placeholders
 *   - the tests pass either way
 *
 * `whichLoaded()` reports what was used, so a brief generated from placeholder
 * content can say so rather than quietly looking authoritative.
 */

const ROOT = path.join(__dirname, '..');
const loaded = new Map();

function resolve(relPath) {
  const real = path.join(ROOT, relPath);
  if (fs.existsSync(real)) return { file: real, isExample: false };

  const ext = path.extname(relPath);
  const example = path.join(ROOT, relPath.slice(0, -ext.length) + '.example' + ext);
  if (fs.existsSync(example)) return { file: example, isExample: true };

  throw new Error(
    `Playbook file missing: neither ${relPath} nor its .example sibling exists. ` +
    `Copy the .example file to ${relPath} and fill it in.`
  );
}

function load(relPath) {
  const { file, isExample } = resolve(relPath);
  loaded.set(relPath, isExample);
  return require(file);
}

/** true if ANY playbook file in use is placeholder content. */
function usingExamples() {
  return [...loaded.values()].some(Boolean);
}

function whichLoaded() {
  return Object.fromEntries([...loaded.entries()].map(([k, v]) => [k, v ? 'example' : 'real']));
}

module.exports = { load, resolve, usingExamples, whichLoaded };
