'use strict';
const fs = require('node:fs');
const { assert, REPO, MAX_FILE } = require('./common.cjs');
function headers(token, accept = 'application/vnd.github+json') {
  assert(token && !/[\r\n]/.test(token), 'Release credential unavailable');
  return { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'ALTARA-protected-native-release' };
}
async function api(endpoint, token, options = {}) {
  assert(endpoint.startsWith(`/repos/${REPO}/`) && !/[#\r\n]/.test(endpoint));
  assert(!endpoint.includes('?') || new RegExp(`^/repos/${REPO}/releases\\?per_page=100&page=[1-5]$`).test(endpoint));
  const result = await fetch(`https://api.github.com${endpoint}`, { ...options,
    headers: { ...headers(token), ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!result.ok) { const error = new Error('Release metadata operation failed'); error.status = result.status; throw error; }
  const text = await result.text(); assert(Buffer.byteLength(text) <= 4 * 1024 ** 2);
  return JSON.parse(text);
}
async function findRelease(tag, token) {
  let matches = [];
  for (let page = 1; page <= 5; page++) {
    const rows = await api(`/repos/${REPO}/releases?per_page=100&page=${page}`, token);
    assert(Array.isArray(rows));
    matches.push(...rows.filter(row => row.tag_name === tag));
    if (rows.length < 100) break;
  }
  assert(matches.length <= 1, 'Ambiguous staging release identity');
  return matches[0] || null;
}
function validDownload(url) {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && (['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
      || /^[a-z0-9.-]+\.blob\.core\.windows\.net$/.test(url.hostname));
}
async function downloadAsset(id, destination, token) {
  assert(/^[1-9][0-9]*$/.test(String(id)));
  let url = new URL(`https://api.github.com/repos/${REPO}/releases/assets/${id}`);
  for (let redirects = 0; redirects < 6; redirects++) {
    assert(validDownload(url), 'Untrusted release asset destination');
    const response = await fetch(url, { headers: url.hostname === 'api.github.com' ? headers(token, 'application/octet-stream') : {},
      redirect: 'manual', signal: AbortSignal.timeout(600_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); assert(location); url = new URL(location, url); continue;
    }
    assert(response.ok && response.body, 'Protected input download failed');
    const length = Number(response.headers.get('content-length') || 0);
    assert(length < MAX_FILE);
    const fd = fs.openSync(destination, 'wx', 0o600);
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength; assert(bytes < MAX_FILE);
        fs.writeSync(fd, chunk);
      }
    } finally { fs.closeSync(fd); }
    assert(bytes > 0 && (!length || length === bytes));
    return bytes;
  }
  throw new Error('Protected input redirect limit');
}
async function uploadAsset(release, filename, token) {
  const name = require('node:path').basename(filename);
  assert(/^[a-zA-Z0-9._-]+$/.test(name));
  const stat = fs.lstatSync(filename); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < MAX_FILE);
  const result = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { ...headers(token), 'Content-Type': 'application/octet-stream', 'Content-Length': String(stat.size) },
    body: fs.createReadStream(filename), duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(600_000) });
  assert(result.ok, 'Release asset upload failed');
  const output = await result.json();
  assert(output.name === name && output.state === 'uploaded' && output.size === stat.size);
  return output;
}
module.exports = { api, findRelease, downloadAsset, uploadAsset, validDownload };
