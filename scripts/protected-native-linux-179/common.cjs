'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const VERSION = '0.1.179';
const SOURCE = '7e25fafc112d3d2a3641fea84fdb753d0efc5811';
const BASELINE = '15b7bd51c2df2390a9e8677179455ccb8fdcf534';
const REPO = 'PinticeBTW/altara-updates';
const SOURCE_TAG = 'ci-source-0.1.179-7e25faf-linux-v1';
const SOURCE_ASSET = 'altara-source-0.1.179-7e25faf-linux-v1.tar.gz.enc';
const COMMANDS_SHA = 'ebe41750e60f99ad5b6a34054c3aa979b78d6fd8fe554a7a3cb6ac8a211b942f';
const MAX_FILE = 2 * 1024 ** 3;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function assert(value, message = 'Protected release invariant failed') { if (!value) throw new Error(message); }
function cleanEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    if (/^(?:ALTARA_CI_KEY|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN|ACTIONS_ID_TOKEN_REQUEST_URL|INPUT_.*TOKEN|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_DIR|GIT_WORK_TREE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES)$/i.test(name)) delete result[name];
  }
  result.GIT_CONFIG_NOSYSTEM = '1';
  result.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  result.GIT_TERMINAL_PROMPT = '0';
  return result;
}
function context(environment = process.env) {
  assert(environment.GITHUB_REPOSITORY === REPO);
  assert(environment.GITHUB_EVENT_NAME === 'workflow_dispatch');
  assert((environment.GITHUB_WORKFLOW_REF || '').startsWith('PinticeBTW/altara-updates/.github/workflows/build-protected-linux-release-179.yml@refs/heads/'));
  assert(/^[0-9a-f]{40}$/.test(environment.GITHUB_SHA || ''));
  assert(/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ID || ''));
  assert(/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ATTEMPT || ''));
  assert(environment.ALTARA_NATIVE_PLATFORM === 'linux');
  assert(path.isAbsolute(environment.RUNNER_TEMP || ''));
  const event = JSON.parse(fs.readFileSync(environment.GITHUB_EVENT_PATH, 'utf8'));
  const inputs = event.inputs || {};
  assert(inputs.source_commit === SOURCE);
  assert(/^[1-9][0-9]*$/.test(inputs.source_asset_id || ''));
  for (const key of ['source_cipher_sha256', 'source_archive_sha256']) assert(/^[0-9a-f]{64}$/.test(inputs[key] || ''));
  assert(inputs.platform === 'linux');
  assert(event.repository?.full_name === REPO && event.repository?.private === false);
  const result = { version: VERSION, sourceCommit: SOURCE, baselineCommit: BASELINE, testOnly: false,
    workflowCommit: environment.GITHUB_SHA, runRepo: REPO, runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT, platform: environment.ALTARA_NATIVE_PLATFORM };
  result.root = path.join(environment.RUNNER_TEMP, `altara-release-179-${result.platform}`);
  result.inputs = inputs;
  return result;
}
function metadata(kind, extra = {}) { return { format: 1, kind, version: VERSION, sourceCommit: SOURCE, baselineCommit: BASELINE, testOnly: false, ...extra }; }
function provenance(c) { const { root, inputs, ...safe } = c; return safe; }
function readState(c) {
  const state = JSON.parse(fs.readFileSync(path.join(c.root, 'state.json'), 'utf8'));
  for (const [key, value] of Object.entries(provenance(c))) assert(state[key] === value);
  return state;
}
function writeState(c, state) {
  const filename = path.join(c.root, 'state.json');
  const temp = filename + '.next';
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, filename);
}
function runCaptured(command, args, { cwd, log, env = cleanEnvironment(), timeout = 120_000 } = {}) {
  const fd = fs.openSync(log, 'a', 0o600);
  let result;
  try { result = spawnSync(command, args, { cwd, env, stdio: ['ignore', fd, fd], timeout, windowsHide: true, killSignal: 'SIGKILL' }); }
  finally { fs.closeSync(fd); }
  assert(!result.error && !result.signal && result.status === 0, 'Protected command failed');
}
async function digestFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function privateError(c, phase, error) {
  try {
    fs.mkdirSync(path.join(c.root, 'logs'), { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(c.root, 'logs', `${phase}-error.log`), String(error?.stack || error) + '\n', { mode: 0o600 });
  } catch { /* No raw error reaches the public console, including failure to record it. */ }
}
module.exports = { VERSION, SOURCE, BASELINE, REPO, SOURCE_TAG, SOURCE_ASSET, COMMANDS_SHA, MAX_FILE, sha256, assert,
  cleanEnvironment, context, metadata, provenance, readState, writeState, runCaptured, digestFile, privateError };
