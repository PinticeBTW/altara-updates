'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { assert, context, readState, writeState, cleanEnvironment, digestFile, runCaptured, privateError, sha256, COMMANDS_SHA } = require('../common.cjs');
const { parseEnvironment } = require('../run-private-step.cjs');
const ORDER = ['dependencies', 'example-dependencies', 'browser-fixtures'];
async function main() {
  const c = context(), state = readState(c), id = process.argv[2];
  assert((process.env.GITHUB_WORKFLOW_REF || '').startsWith('PinticeBTW/altara-updates/.github/workflows/diagnose-protected-browser.yml@refs/heads/'));
  assert(state.sourceVerified === true && state.completed.length === 0);
  assert(state.sourceDirectory === process.env.ALTARA_SOURCE_DIR && process.versions.node === '22.18.0');
  state.diagnosticOnly = true;
  state.diagnosticSetupCompleted ||= [];
  assert(ORDER[state.diagnosticSetupCompleted.length] === id);
  const filename = path.join(state.sourceDirectory, '.git', 'release-ci', 'private-steps.json');
  assert(await digestFile(filename) === COMMANDS_SHA && state.commandInventorySha256 === COMMANDS_SHA);
  const inventory = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const matches = inventory[c.platform].filter(step => step.id === id);
  assert(matches.length === 1);
  const step = matches[0];
  assert(step.tokenRequired === false && sha256(Buffer.from(step.command)) === step.commandSha256);
  writeState(c, state);
  const script = path.join(c.root, `diagnostic-${id}.${step.shell === 'pwsh' ? 'ps1' : 'sh'}`);
  fs.writeFileSync(script, (step.shell === 'pwsh' ? '$ErrorActionPreference="Stop"\n$PSNativeCommandUseErrorActionPreference=$true\n' : 'set -euo pipefail\n') + step.command + '\n', { flag: 'wx', mode: 0o600 });
  const exportFile = path.join(c.root, `diagnostic-${id}.env`);
  fs.writeFileSync(exportFile, '', { flag: 'wx', mode: 0o600 });
  const environment = { ...cleanEnvironment(), ...state.environment, GITHUB_ENV: exportFile,
    GITHUB_PATH: path.join(c.root, 'diagnostic-unused-path'), GITHUB_OUTPUT: path.join(c.root, 'diagnostic-unused-output'),
    GITHUB_STEP_SUMMARY: path.join(c.root, 'diagnostic-unused-summary') };
  if (c.platform === 'linux') environment.NODE_OPTIONS = '--max-old-space-size=2048';
  const args = step.shell === 'pwsh' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script] : ['--noprofile', '--norc', script];
  runCaptured(step.shell, args, { cwd: state.sourceDirectory, env: environment, log: path.join(c.root, 'logs', `diagnostic-${id}.log`), timeout: 20 * 60_000 });
  Object.assign(state.environment, parseEnvironment(fs.readFileSync(exportFile, 'utf8')));
  state.diagnosticSetupCompleted.push(id);
  assert(state.completed.length === 0);
  writeState(c, state);
  console.log('Protected diagnostic prerequisites prepared.');
}
main().catch(error => {
  try { privateError(context(), 'diagnostic-setup', error); } catch { /* Public output stays generic. */ }
  console.error('Protected diagnostic preparation failed.'); process.exitCode = 1;
});
