'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assert, context, cleanEnvironment, metadata, provenance, writeState, privateError, runCaptured,
  SOURCE, BASELINE, VERSION, REPO, SOURCE_TAG, SOURCE_ASSET, COMMANDS_SHA, digestFile } = require('./common.cjs');
const { decrypt, keyFromEnvironment } = require('./envelope.cjs');
const { api, findRelease, downloadAsset } = require('./github.cjs');
function filesUnder(root, prefix = '') {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    assert(!entry.isSymbolicLink(), 'Source links are forbidden');
    const relative = prefix + entry.name;
    return entry.isDirectory() ? filesUnder(path.join(root, entry.name), relative + '/') : (assert(entry.isFile()), [relative]);
  });
}
function gitOutput(source, args, log) {
  const result = spawnSync('git', args, { cwd: source, env: cleanEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 ** 2, timeout: 120_000, windowsHide: true });
  fs.appendFileSync(log, (result.stdout || '') + (result.stderr || ''), { mode: 0o600 });
  assert(!result.error && !result.signal && result.status === 0, 'Source Git verification failed');
  return result.stdout;
}
async function main() {
  const c = context();
  fs.mkdirSync(c.root, { mode: 0o700 });
  fs.mkdirSync(path.join(c.root, 'logs'), { mode: 0o700 });
  const state = { ...provenance(c), sourceVerified: false, completed: [], environment: {} };
  writeState(c, state);
  const key = keyFromEnvironment();
  try {
    const release = await findRelease(SOURCE_TAG, process.env.GH_TOKEN);
    assert(release && release.draft === true && release.tag_name === SOURCE_TAG && !release.prerelease);
    const assets = release.assets || [];
    assert(assets.length === 1 && assets[0].name === SOURCE_ASSET && assets[0].state === 'uploaded');
    const asset = assets[0];
    assert(String(asset.id) === c.inputs.source_asset_id && asset.size > 0);
    assert(asset.digest === `sha256:${c.inputs.source_cipher_sha256}`);
    const cipher = path.join(c.root, 'source.tar.gz.enc');
    await downloadAsset(asset.id, cipher, process.env.GH_TOKEN);
    const archive = path.join(c.root, 'source.tar.gz');
    await decrypt(cipher, archive, metadata('source'), key, c.inputs.source_cipher_sha256, c.inputs.source_archive_sha256);
    const extracted = path.join(c.root, 'source');
    const log = path.join(c.root, 'logs', 'bootstrap.log');
    // The decrypt key and repository token never reach Python or Git children.
    runCaptured(process.platform === 'win32' ? 'python' : 'python3', [path.join(__dirname, 'extract-source.py'), archive, extracted], { log, env: cleanEnvironment() });
    const source = path.join(extracted, 'current');
    const entries = filesUnder(source);
    for (const relative of entries.filter(name => name.startsWith('.git/'))) {
      assert(/^\.git\/(?:HEAD|config|shallow|index|packed-refs|release-input\.json|release-ci\/private-steps\.json|objects\/[0-9a-f]{2}\/[0-9a-f]{38}|objects\/pack\/pack-[0-9a-f]{40}\.(?:pack|idx|rev)|refs\/(?:heads|tags)\/[a-zA-Z0-9._/-]+)$/.test(relative), 'Unexpected source Git metadata');
    }
    // Never trust a transported Git config (include paths, filters, hooks,
    // credentials or remotes). Only immutable object identity is transported.
    fs.writeFileSync(path.join(source, '.git', 'config'), '[core]\nrepositoryformatversion = 0\nfilemode = false\nbare = false\nautocrlf = false\nlogallrefupdates = false\n');
    assert(gitOutput(source, ['rev-parse', 'HEAD'], log).trim() === SOURCE);
    gitOutput(source, ['cat-file', '-e', `${BASELINE}^{commit}`], log);
    gitOutput(source, ['fsck', '--connectivity-only', '--no-reflogs'], log);
    gitOutput(source, ['diff', '--exit-code', 'HEAD', '--'], log);
    const tracked = new Set(gitOutput(source, ['ls-files', '-z'], log).split('\0').filter(Boolean));
    const supplied = entries.filter(name => !name.startsWith('.git/'));
    assert(supplied.length === tracked.size && supplied.every(name => tracked.has(name)), 'Unexpected source file inventory');
    const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    assert(pkg.version === VERSION);
    state.sourceVerified = true;
    state.sourceDirectory = source;
    state.sourceAssetId = String(asset.id);
    state.sourceCipherSha256 = c.inputs.source_cipher_sha256;
    state.sourceArchiveSha256 = c.inputs.source_archive_sha256;
    state.commandInventorySha256 = await digestFile(path.join(source, '.git', 'release-ci', 'private-steps.json'));
    assert(state.commandInventorySha256 === COMMANDS_SHA, 'Protected command inventory mismatch');
    writeState(c, state);
    assert(path.isAbsolute(process.env.GITHUB_ENV || '') && !/[\r\n]/.test(source));
    fs.appendFileSync(process.env.GITHUB_ENV, `ALTARA_SOURCE_SHA=${SOURCE}\nALTARA_SOURCE_DIR=${source}\n`);
    // No plaintext archive needs to survive validation. The checked-out files
    // stay confined to this ephemeral runner until its normal destruction.
    fs.rmSync(archive);
    console.log('Protected source identity verified.');
  } finally { key.fill(0); }
}
if (require.main === module) main().catch(error => {
  try { privateError(context(), 'bootstrap', error); } catch { /* Keep public failure generic. */ }
  console.error('Protected source preparation failed.'); process.exitCode = 1;
});
module.exports = { filesUnder, gitOutput };
