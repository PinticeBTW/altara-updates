'use strict';
// Authenticated file transport built exclusively on Node's maintained crypto API.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { assert, MAX_FILE, metadata, digestFile } = require('./common.cjs');
const MAGIC = Buffer.from('ALTARA-GCM-01\n');
function keyFromEnvironment(environment = process.env) {
  assert(/^[0-9a-f]{64}$/.test(environment.ALTARA_CI_KEY || ''), 'Transport key unavailable');
  return Buffer.from(environment.ALTARA_CI_KEY, 'hex');
}
async function encrypt(input, output, suppliedMetadata, key) {
  assert(key?.length === 32);
  const stat = fs.lstatSync(input);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < MAX_FILE);
  const header = Buffer.from(JSON.stringify({ ...suppliedMetadata, plaintextBytes: stat.size, plaintextSha256: await digestFile(input) }));
  assert(header.length <= 4096);
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  const nonce = crypto.randomBytes(12);
  const prefix = Buffer.concat([MAGIC, length, header, nonce]);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(prefix);
  const fd = fs.openSync(output, 'wx', 0o600);
  fs.writeSync(fd, prefix); fs.closeSync(fd);
  try {
    await pipeline(fs.createReadStream(input), cipher, fs.createWriteStream(output, { flags: 'a', mode: 0o600 }));
    fs.appendFileSync(output, cipher.getAuthTag());
    return { bytes: fs.statSync(output).size, sha256: await digestFile(output), metadata: JSON.parse(header) };
  } catch (error) { fs.rmSync(output, { force: true }); throw error; }
}
async function decrypt(input, output, expectedMetadata, key, expectedCipherSha256, expectedPlaintextSha256) {
  assert(key?.length === 32 && /^[0-9a-f]{64}$/.test(expectedCipherSha256 || ''));
  const size = fs.lstatSync(input).size;
  assert(size > MAGIC.length + 4 + 12 + 16 && size < MAX_FILE);
  assert(await digestFile(input) === expectedCipherSha256, 'Encrypted input digest mismatch');
  const fd = fs.openSync(input, 'r');
  let prefix, header, tag;
  try {
    const first = Buffer.alloc(MAGIC.length + 4); assert(fs.readSync(fd, first, 0, first.length, 0) === first.length);
    assert(first.subarray(0, MAGIC.length).equals(MAGIC), 'Envelope format mismatch');
    const length = first.readUInt32BE(MAGIC.length); assert(length > 0 && length <= 4096);
    prefix = Buffer.alloc(first.length + length + 12); assert(fs.readSync(fd, prefix, 0, prefix.length, 0) === prefix.length);
    header = JSON.parse(prefix.subarray(first.length, first.length + length));
    tag = Buffer.alloc(16); assert(fs.readSync(fd, tag, 0, 16, size - 16) === 16);
  } finally { fs.closeSync(fd); }
  for (const [key, value] of Object.entries(expectedMetadata)) assert(header[key] === value, 'Envelope identity mismatch');
  assert(Number.isSafeInteger(header.plaintextBytes) && header.plaintextBytes > 0 && header.plaintextBytes < MAX_FILE);
  assert(/^[0-9a-f]{64}$/.test(header.plaintextSha256 || ''));
  if (expectedPlaintextSha256) assert(header.plaintextSha256 === expectedPlaintextSha256, 'Archive identity mismatch');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, prefix.subarray(-12));
  decipher.setAAD(prefix); decipher.setAuthTag(tag);
  // Unauthenticated plaintext is confined to a private temporary file. No
  // parser, extractor, Git operation or caller can access it before final().
  const pending = output + '.unauthenticated';
  assert(!fs.existsSync(output));
  const pendingFd = fs.openSync(pending, 'wx', 0o600);
  let bytes = 0;
  const bound = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes <= header.plaintextBytes ? null : new Error('Plaintext exceeds envelope bounds'), chunk);
  }});
  try {
    await pipeline(fs.createReadStream(input, { start: prefix.length, end: size - 17 }), decipher, bound,
      fs.createWriteStream(pending, { fd: pendingFd, autoClose: true }));
    assert(bytes === header.plaintextBytes && await digestFile(pending) === header.plaintextSha256);
    fs.copyFileSync(pending, output, fs.constants.COPYFILE_EXCL);
    fs.rmSync(pending);
    return header;
  } catch (error) { fs.rmSync(pending, { force: true }); throw error; }
}
module.exports = { encrypt, decrypt, keyFromEnvironment };
if (require.main === module) (async () => {
  const [mode, input, output, kind = 'source'] = process.argv.slice(2);
  assert(mode === 'encrypt' && ['source', 'diagnostics'].includes(kind), 'Use: encrypt INPUT OUTPUT source');
  const key = keyFromEnvironment();
  try { const receipt = await encrypt(input, output, metadata(kind), key); console.log(JSON.stringify(receipt)); }
  finally { key.fill(0); }
})().catch(() => { console.error('Protected transport operation failed.'); process.exitCode = 1; });
