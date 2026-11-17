'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { assert, context, metadata, provenance, readState, privateError, digestFile, REPO, SOURCE, VERSION, COMMANDS_SHA } = require('./common.cjs');
const { encrypt, keyFromEnvironment } = require('./envelope.cjs');
const { api, findRelease, uploadAsset } = require('./github.cjs');
const expectedSteps = {
  windows: ['postgres', 'postgres-location', 'historical-installer', 'dependencies', 'example-dependencies', 'browser-fixtures', 'native-prepack', 'renderer-validation', 'widget-network-validation', 'baseline', 'ui-evidence', 'release-validation', 'package', 'checksums'],
  linux: ['postgres-location', 'historical-installer', 'dependencies', 'example-dependencies', 'browser-fixtures', 'sandbox', 'baseline', 'ui-evidence', 'release-validation', 'version', 'package', 'appimage-validation', 'deb-validation', 'portable-validation'],
};
const packageNames = {
  windows: [`Altara.Setup.${VERSION}.exe`, `Altara.Setup.${VERSION}.exe.blockmap`, `Altara.Setup.${VERSION}.exe.sha256`, 'latest.yml'],
  linux: [`Altara-${VERSION}-x86_64.AppImage`, `Altara-${VERSION}-amd64.deb`, `Altara.${VERSION}.tar.gz`, 'latest-linux.yml', `README-LINUX-${VERSION}.txt`, `SHA256SUMS-linux-${VERSION}.txt`],
};
function evidenceFiles(root, suffix, maxTotal) {
  const result = {}; let total = 0;
  if (!fs.existsSync(root)) return result;
  assert(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink());
  for (const name of fs.readdirSync(root).filter(name => suffix.test(name))) {
    const filename = path.join(root, name), stat = fs.lstatSync(filename);
    assert(stat.isFile() && !stat.isSymbolicLink());
    total += stat.size; assert(total < maxTotal);
    result[name] = fs.readFileSync(filename, 'utf8');
  }
  return result;
}
function validateGates(files, platform) {
  assert(platform === 'windows', 'This candidate is Windows physical testing only');
  const summary = JSON.parse(files['summary.json']);
  assert(summary.validationScope === 'desktop-release' && summary.historicalComparisonIncluded === false);
  for (const gate of ['required', 'focused', 'widget', 'features']) {
    const row = summary[gate];
    assert(row && row.failed === 0 && row.cancelled === 0 && row.todo === 0 && row.passed > 0);
  }
  assert(summary.required.tests === 566 && summary.required.passed === 564 && summary.required.skipped === 2);
  assert(summary.focused.tests === 228 && summary.focused.passed === 227);
  assert(summary.widget.tests === 2 && summary.widget.passed === 2);
  assert(summary.focused.skipped === 1 && summary.widget.skipped === 0 && summary.features.skipped === 0);
  assert(summary.features.tests === 653 && summary.features.passed === 653);
  for (const gate of ['release-required', 'desktop-focused', 'widget-focused', 'shipping-feature-focused']) {
    const inventory = JSON.parse(files[`${gate}-inventory.json`]);
    assert(inventory.selected.length > 0 && inventory.selected.length === inventory.covered.length);
    const normalize = name => name.replaceAll('\\', '/');
    const selected = new Set(inventory.selected.map(normalize)), covered = new Set(inventory.covered.map(normalize));
    assert(selected.size === inventory.selected.length && covered.size === inventory.covered.length);
    assert([...selected].every(name => name.startsWith('tests/') && covered.has(name)));
    const events = files[`${gate}.jsonl`].split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const final = events.filter(event => event.type === 'test:summary' && !event.file).at(-1);
    assert(final?.success === true && final.counts.failed === 0 && final.counts.cancelled === 0 && final.counts.todo === 0);
    const summaryName = { 'release-required': 'required', 'desktop-focused': 'focused', 'widget-focused': 'widget', 'shipping-feature-focused': 'features' }[gate];
    for (const key of ['tests', 'passed', 'failed', 'cancelled', 'todo', 'skipped']) assert(final.counts[key] === summary[summaryName][key], 'Gate aggregate identity mismatch');
    assert(!events.some(event => event.type === 'test:fail'));
    if (gate === 'release-required') assert(inventory.selected.length === 38);
    if (gate === 'desktop-focused') {
      assert(inventory.selected.length === 26);
      assert(inventory.selectedTestSkipPattern === '^native Electron zoom100/106/125 keeps the Mac footer aligned$');
      assert(events.filter(e => e.type === 'test:pass' && String(e.file || '').endsWith('widgets-edit-navigation.test.mjs')).length === 25);
      assert(inventory.selected.includes('tests/dm-prompt-focus-ownership-browser.test.mjs'));
      assert(events.filter(e => e.type === 'test:pass' && String(e.file || '').endsWith('dm-prompt-focus-ownership-browser.test.mjs')).length === 5);
      for (const [file, count] of Object.entries({ 'desktop-mic-processing-resume': 12,
        'livekit-microphone-settings-refresh': 8, 'private-call-microphone-readiness-status': 4,
        'activity-card-artwork': 6 })) {
        assert(inventory.selected.includes(`tests/${file}.test.mjs`));
        assert(events.filter(e => e.type === 'test:pass' && String(e.file || '').endsWith(`${file}.test.mjs`)).length === count);
      }
    }
    if (gate === 'shipping-feature-focused') {
      assert(inventory.selected.length === 50);
      assert(events.filter(e => e.type === 'test:pass' && String(e.file || '').endsWith('avatar-style-picker-browser.test.mjs')).length === 15);
      for (const file of ['profile-activity-stack', 'profile-mini-presence-browser']) {
        assert(inventory.selected.includes(`tests/${file}.test.mjs`));
        assert(events.filter(e => e.type === 'test:pass' && String(e.file || '').endsWith(`${file}.test.mjs`)).length === 3);
      }
    }
  }
  return summary;
}
async function releaseFor(c, token, create = false) {
  const tag = `ci-test-native-${VERSION}-${SOURCE.slice(0, 7)}-${c.runId}`;
  let release = await findRelease(tag, token);
  if (!release && create) {
    release = await api(`/repos/${REPO}/releases`, token, { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: c.workflowCommit,
      name: `Windows physical test ${VERSION} / ${c.runId}`, body: 'Unpublished Windows test installer and encrypted diagnostics. Physical validation is pending. This is not a stable release.', draft: true, prerelease: true }) });
  }
  assert(release && release.draft === true && release.prerelease === true && release.tag_name === tag && release.target_commitish === c.workflowCommit);
  return release;
}
async function preserve(release, filename, token) {
  const digest = await digestFile(filename), stat = fs.statSync(filename), name = path.basename(filename);
  const current = await api(`/repos/${REPO}/releases/${release.id}`, token);
  assert(current.draft && current.target_commitish === release.target_commitish);
  const existing = current.assets.filter(row => row.name === name);
  assert(existing.length <= 1);
  if (existing.length) assert(existing[0].state === 'uploaded' && existing[0].size === stat.size && existing[0].digest === `sha256:${digest}`, 'Refusing to overwrite an existing CI asset');
  else {
    const output = await uploadAsset(current, filename, token);
    assert(output.digest === `sha256:${digest}`);
  }
  return { name, bytes: stat.size, sha256: digest };
}
async function main() {
  const c = context(), token = process.env.GH_TOKEN, key = keyFromEnvironment();
  fs.mkdirSync(c.root, { recursive: true, mode: 0o700 });
  try {
    let state;
    try { state = readState(c); } catch { state = { ...provenance(c), sourceVerified: false, completed: [] }; }
    const tests = evidenceFiles(path.join(c.root, 'source', 'current', 'audit-output', 'release-tests'), /\.(?:json|jsonl)$/, 120 * 1024 ** 2);
    const logs = evidenceFiles(path.join(c.root, 'logs'), /\.log$/, 512 * 1024 ** 2);
    const payload = { ...provenance(c), sourceVerified: state.sourceVerified, completed: state.completed, files: tests, logs };
    const raw = path.join(c.root, `ci-tests-${c.platform}-${c.runId}.json.gz`);
    fs.writeFileSync(raw, zlib.gzipSync(JSON.stringify(payload)), { flag: 'wx', mode: 0o600 });
    const cipher = raw + '.enc';
    const transport = await encrypt(raw, cipher, metadata('diagnostics', provenance(c)), key);
    fs.rmSync(raw);
    const release = await releaseFor(c, token);
    const diagnostic = await preserve(release, cipher, token);
    let gates = null;
    const successful = process.env.ALTARA_JOB_STATUS === 'success' && state.sourceVerified === true
      && JSON.stringify(state.completed) === JSON.stringify(expectedSteps[c.platform]) && state.commandInventorySha256 === COMMANDS_SHA;
    const packageRows = [];
    if (successful) {
      gates = validateGates(tests, c.platform);
      const folder = path.join(state.sourceDirectory, c.platform === 'windows' ? 'dist-release' : 'dist-linux-release');
      for (const name of packageNames[c.platform]) packageRows.push(await preserve(release, path.join(folder, name), token));
    }
    const manifest = { format: 2, ...provenance(c), readyForPhysicalTest: successful, readyForCollection: false, jobStatus: process.env.ALTARA_JOB_STATUS,
      sourceAssetId: state.sourceAssetId || null, sourceCipherSha256: state.sourceCipherSha256 || null,
      sourceArchiveSha256: state.sourceArchiveSha256 || null, commandInventorySha256: state.commandInventorySha256 || null,
      completedStages: state.completed, gates, files: packageRows, diagnostic: { ...diagnostic, envelope: transport.metadata } };
    const target = path.join(c.root, `ci-manifest-${c.platform}-${c.runId}.json`);
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await preserve(release, target, token);
    console.log(successful ? 'Validated native packages and encrypted diagnostics retained in staging.' : 'Encrypted diagnostics retained; no packages were uploaded.');
    assert(successful, 'Native release validation remains incomplete');
  } finally { key.fill(0); }
}
if (require.main === module) main().catch(error => {
  try { privateError(context(), 'finish', error); } catch { /* No unprotected diagnostics on stdout. */ }
  console.error('Protected native release remains blocked.'); process.exitCode = 1;
});
module.exports = { expectedSteps, packageNames, validateGates, evidenceFiles, releaseFor };
