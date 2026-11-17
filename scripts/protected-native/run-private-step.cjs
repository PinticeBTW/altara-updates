'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { assert, context, cleanEnvironment, readState, writeState, runCaptured, privateError, sha256, digestFile, COMMANDS_SHA } = require('./common.cjs');
const allowedEnvironment = /^(?:PGBIN|CHROME_DEVEL_SANDBOX|ALTARA_(?:RELEASE_TEST_PG_BIN|PROFILE_ACTIVITY_PG_BIN|PROFILE_ACTIVITY_TEST_REPORTER|SV_MEDIA_TEST_REPORTER|FROZEN_RUNTIME_INSTALLER|HEADLESS_SHELL_EXECUTABLE|SUPABASE_SDK_BUNDLE|SUPABASE_SDK_SHA256|THEME_ZIP_MODULE|THEME_FULL_APP_SDK|PTBR_PLAYWRIGHT|PLAYWRIGHT_MODULE|AUDIO_PLAYWRIGHT|AUTH_PLAYWRIGHT|BILLING_PLAYWRIGHT|BLOCKERS_PLAYWRIGHT|BR_PRIVACY_PLAYWRIGHT|DM_HEADER_PLAYWRIGHT|FOUNDING_PLAYWRIGHT|HANDOFF_PLAYWRIGHT|INVITE_PLAYWRIGHT|MESSAGE_PLAYWRIGHT|PROFILE_ANCHOR_PLAYWRIGHT|WALLPAPER_PLAYWRIGHT|PTBR_CHROME|VAULT_CHROME_PATH|CHROMIUM|TEST_CHROME|BR_PRIVACY_CHROME|INVITE_BROWSER_EXECUTABLE|TEST_TOOLS_ROOT|PGLITE_MODULE|POLLS_PG_WORK|THEME_ARTIFACT_DIR|GLASS_FULL_APP_OUTPUT|THEME_COMMERCE_PG_BIN|THEME_COMMERCE_PG_WORK|RELEASE_VERSION))$/;
function parseEnvironment(text) {
  const result = {};
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)) {
    const split = line.indexOf('=');
    assert(split > 0, 'Unsupported private environment syntax');
    const key = line.slice(0, split), value = line.slice(split + 1);
    assert(allowedEnvironment.test(key) && !/[\r\n\0]/.test(value) && value.length < 16_384);
    result[key] = value;
  }
  return result;
}
async function main() {
  const c = context(), id = process.argv[2];
  const state = readState(c);
  assert(state.sourceVerified === true && state.sourceDirectory === process.env.ALTARA_SOURCE_DIR);
  const commandFile = path.join(state.sourceDirectory, '.git', 'release-ci', 'private-steps.json');
  assert(await digestFile(commandFile) === COMMANDS_SHA && state.commandInventorySha256 === COMMANDS_SHA);
  const inventory = JSON.parse(fs.readFileSync(commandFile, 'utf8'));
  const steps = inventory[c.platform], index = state.completed.length, step = steps[index];
  assert(step && step.id === id && /^[a-z-]+$/.test(id), 'Protected stage order mismatch');
  assert(sha256(Buffer.from(step.command)) === step.commandSha256);
  const shellFile = path.join(c.root, `${String(index).padStart(2, '0')}-${id}.${step.shell === 'pwsh' ? 'ps1' : 'sh'}`);
  const prefix = step.shell === 'pwsh' ? '$ErrorActionPreference = "Stop"\n$PSNativeCommandUseErrorActionPreference = $true\n' : 'set -euo pipefail\n';
  fs.writeFileSync(shellFile, prefix + step.command + '\n', { flag: 'wx', mode: 0o600 });
  const environmentFile = path.join(c.root, `environment-${index}.txt`);
  fs.writeFileSync(environmentFile, '', { flag: 'wx', mode: 0o600 });
  const environment = { ...cleanEnvironment(), ...state.environment, ...step.environment, GITHUB_ENV: environmentFile,
    GITHUB_PATH: path.join(c.root, `unused-path-${index}.txt`), GITHUB_OUTPUT: path.join(c.root, `unused-output-${index}.txt`),
    GITHUB_STEP_SUMMARY: path.join(c.root, `unused-summary-${index}.txt`) };
  if (c.platform === 'linux') environment.NODE_OPTIONS = '--max-old-space-size=2048';
  if (step.tokenRequired) { assert(process.env.GH_TOKEN); environment.GH_TOKEN = process.env.GH_TOKEN; }
  const args = step.shell === 'pwsh' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', shellFile] : ['--noprofile', '--norc', shellFile];
  runCaptured(step.shell, args, { cwd: state.sourceDirectory, env: environment, log: path.join(c.root, 'logs', `${id}.log`), timeout: 100 * 60_000 });
  Object.assign(state.environment, parseEnvironment(fs.readFileSync(environmentFile, 'utf8')));
  state.completed.push(id);
  writeState(c, state);
  console.log(`Protected stage ${index + 1}/${steps.length} passed.`);
}
if (require.main === module) main().catch(error => {
  try { privateError(context(), 'stage', error); } catch { /* Never expose subprocess errors. */ }
  console.error('Protected validation stage failed. Encrypted diagnostics will be retained.'); process.exitCode = 1;
});
module.exports = { parseEnvironment, allowedEnvironment };
