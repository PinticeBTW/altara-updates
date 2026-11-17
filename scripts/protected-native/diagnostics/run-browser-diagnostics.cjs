'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { assert, context, readState, cleanEnvironment, digestFile, runCaptured, privateError } = require('../common.cjs');
const targets = {
  windows: { file: 'dm-code-dialog-ui.test.mjs', sha256: '81281935c1f7a56f8fe6cc8ac809c3f1c7630a423cce57b329a98c97b1ec6505' },
  linux: { file: 'widget-marketplace-browser.test.mjs', sha256: '5d89384f12dd44dcb88baa3216035b059588cc2232cea047baab72aa7efadb79',
    pattern: '^(hosted developer link, ordinary HTML preview|same-name local and online widgets)' },
};
async function main() {
  const c = context(), state = readState(c), target = targets[c.platform];
  assert((process.env.GITHUB_WORKFLOW_REF || '').startsWith('PinticeBTW/altara-updates/.github/workflows/diagnose-protected-browser.yml@refs/heads/'));
  assert(process.versions.node === '22.18.0' && process.platform === (c.platform === 'windows' ? 'win32' : 'linux'));
  assert(state.sourceVerified === true && state.diagnosticOnly === true && state.completed.length === 0);
  assert(JSON.stringify(state.diagnosticSetupCompleted) === JSON.stringify(['dependencies', 'example-dependencies', 'browser-fixtures']));
  const testFile = path.join(state.sourceDirectory, 'tests', target.file);
  assert(await digestFile(testFile) === target.sha256);
  const environment = { ...cleanEnvironment(), ...state.environment,
    ALTARA_BROWSER_DIAGNOSTIC_PLATFORM: c.platform, ALTARA_BROWSER_DIAGNOSTIC_LOG_DIR: path.join(c.root, 'logs'),
    GITHUB_ENV: path.join(c.root, 'diagnostic-unused-env'), GITHUB_OUTPUT: path.join(c.root, 'diagnostic-unused-output'),
    GITHUB_PATH: path.join(c.root, 'diagnostic-unused-path'), GITHUB_STEP_SUMMARY: path.join(c.root, 'diagnostic-unused-summary') };
  if (c.platform === 'linux') environment.NODE_OPTIONS = '--max-old-space-size=2048';
  const results = [];
  for (let attempt = 1; attempt <= 10; attempt++) {
    const label = `browser-${c.platform}-${String(attempt).padStart(2, '0')}`;
    const log = path.join(c.root, 'logs', `${label}-spec.log`);
    assert(!fs.existsSync(log));
    let executionFailed = false;
    try {
      runCaptured(process.execPath, ['--require', path.join(__dirname, 'capture-browser-diagnostics.cjs'), '--test', '--test-concurrency=1',
        '--test-reporter=spec', ...(target.pattern ? [`--test-name-pattern=${target.pattern}`] : []), testFile], {
        cwd: state.sourceDirectory, env: { ...environment, ALTARA_BROWSER_DIAGNOSTIC_ATTEMPT: String(attempt) }, log, timeout: 5 * 60_000 });
    } catch (error) { executionFailed = true; privateError(c, label, error); }
    assert(await digestFile(testFile) === target.sha256);
    results.push({ attempt, executionFailed, sameFailureReproduced: null });
    console.log(`Protected browser diagnostic attempt ${attempt} recorded (maximum 10).`);
    if (executionFailed) break;
  }
  const unchanged = readState(c);
  assert(unchanged.completed.length === 0 && unchanged.diagnosticOnly === true);
  fs.writeFileSync(path.join(c.root, 'logs', 'browser-diagnostic-summary.log'), JSON.stringify({ diagnosticOnly: true,
    sourceCommit: c.sourceCommit, workflowCommit: c.workflowCommit, runId: c.runId, platform: c.platform,
    originalTest: target.file, originalTestSha256: target.sha256, selection: target.pattern || 'complete unchanged file', results,
    maximumAttempts: 10, completedAttempts: results.length, stoppedAfterExecutionFailure: results.at(-1)?.executionFailed === true,
    testBytesUnchanged: true, releaseGateReportsProduced: false, releaseEligible: false, sameFailureReproduced: null,
    timeoutsOrAssertionsChanged: false }) + '\n', { flag: 'wx', mode: 0o600 });
  if (results.some(result => result.executionFailed)) process.exitCode = 1;
}
main().catch(error => {
  try { privateError(context(), 'browser-diagnostic-runner', error); } catch { /* No raw error reaches public logs. */ }
  console.error('Protected browser diagnostic could not complete.'); process.exitCode = 1;
});
