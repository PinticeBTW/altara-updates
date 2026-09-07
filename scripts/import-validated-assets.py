"""Copy an immutable, checksum-verified CI artifact to an existing draft release.

Uses only the built-in token for this repository. The short-lived download URL
is read from the dispatch event, never echoed, committed, or forwarded to GitHub.
Existing release assets must match byte-for-byte; they are never overwritten.
"""
import hashlib
import json
import os
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

REPOSITORY = "PinticeBTW/altara-updates"
inputs = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())["inputs"]
tag = inputs["tag"]
if not re.fullmatch(r"v0\.1\.\d+", tag):
    raise SystemExit("Invalid release tag")
version = tag[1:]
url = inputs["artifact_url"]
parsed = urllib.parse.urlsplit(url)
if parsed.scheme != "https" or parsed.username or parsed.password or not (
    parsed.hostname.endswith(".blob.core.windows.net")
    or parsed.hostname.endswith(".actions.githubusercontent.com")
):
    raise SystemExit("Expected a GitHub Actions artifact download URL")
expected_hash = inputs["artifact_sha256"].removeprefix("sha256:")
if not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
    raise SystemExit("Invalid artifact checksum")
groups = {
    "windows": {f"Altara.Setup.{version}.exe", f"Altara.Setup.{version}.exe.blockmap", f"Altara.Setup.{version}.exe.sha256", "latest.yml"},
    "linux": {f"Altara-{version}-x86_64.AppImage", f"Altara-{version}-amd64.deb", f"Altara.{version}.tar.gz", "latest-linux.yml", f"README-LINUX-{version}.txt", f"SHA256SUMS-linux-{version}.txt"},
}
expected_names = groups[inputs["asset_group"]]
token = os.environ["GH_TOKEN"]

def github(path, method="GET", data=None, content_type="application/json"):
    endpoint = path if path.startswith("https://uploads.github.com/") else "https://api.github.com" + path
    request = urllib.request.Request(endpoint, method=method, data=data, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "Content-Type": content_type,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "altara-validated-release-import",
    })
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"GitHub {method} failed with HTTP {error.code}") from None

release = github(f"/repos/{REPOSITORY}/releases/tags/{tag}")
if not release["draft"] or release["tag_name"] != tag:
    raise SystemExit("Only an existing draft release can receive artifacts")
existing = {asset["name"]: asset for asset in release["assets"]}
with tempfile.TemporaryDirectory(prefix="altara-release-import-") as temporary:
    root = Path(temporary)
    archive = root / "artifact.zip"
    digest = hashlib.sha256()
    try:
        with urllib.request.urlopen(url, timeout=300) as response, archive.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
    except Exception:
        raise RuntimeError("Artifact download failed; obtain a fresh URL and retry") from None
    if digest.hexdigest() != expected_hash:
        raise SystemExit("Artifact ZIP checksum mismatch")
    print(f"Validated {inputs['asset_group']} artifact ZIP: {expected_hash}")
    with zipfile.ZipFile(archive) as zip_file:
        entries = zip_file.infolist()
        if len(entries) != len(expected_names) or {entry.filename for entry in entries} != expected_names:
            raise SystemExit("Unexpected artifact file set")
        for entry in entries:
            if entry.is_dir() or entry.file_size <= 0 or entry.file_size > 1024**3:
                raise SystemExit("Invalid artifact entry")
            (root / entry.filename).write_bytes(zip_file.read(entry))
    checksums = [name for name in expected_names if name.endswith(".sha256") or name.startswith("SHA256SUMS-")]
    for manifest_name in checksums:
        for line in (root / manifest_name).read_text().splitlines():
            sha, name = line.split(maxsplit=1)
            name = name.lstrip("*")
            if name not in expected_names or hashlib.sha256((root / name).read_bytes()).hexdigest() != sha:
                raise SystemExit("Packager SHA-256 manifest mismatch")
    for name in sorted(expected_names):
        data = (root / name).read_bytes()
        digest = "sha256:" + hashlib.sha256(data).hexdigest()
        if name in existing:
            if existing[name]["state"] != "uploaded" or existing[name]["size"] != len(data) or existing[name].get("digest") != digest:
                raise SystemExit("An existing asset differs; refusing to overwrite " + name)
            print("Already verified: " + name)
            continue
        result = github(f"https://uploads.github.com/repos/{REPOSITORY}/releases/{release['id']}/assets?name={urllib.parse.quote(name)}", "POST", data, "application/octet-stream")
        if result["state"] != "uploaded" or result["size"] != len(data) or result.get("digest") != digest:
            raise SystemExit("Uploaded asset verification failed")
        print("Uploaded and verified: " + name + " " + digest)
