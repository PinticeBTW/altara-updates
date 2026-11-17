"""Extract an authenticated, bounded snapshot; never use tar's implicit filters."""
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

MAX_BYTES = 8 * 1024 ** 3
MAX_ENTRIES = 200_000

def extract(archive, destination):
    root = Path(destination)
    root.mkdir(mode=0o700, exist_ok=False)
    seen = set()
    total = 0
    with tarfile.open(archive, 'r:gz') as source:
        entries = []
        for entry in source:
            entries.append(entry)
            if len(entries) > MAX_ENTRIES:
                raise ValueError('Archive inventory limit')
            name = entry.name.rstrip('/')
            parts = PurePosixPath(name).parts
            if (not name or len(name) > 4096 or '\\' in name or ':' in name or '\x00' in name
                    or any(ord(char) < 32 for char in name) or name.startswith('/')
                    or not parts or parts[0] != 'current' or any(part in ('', '.', '..') for part in name.split('/'))
                    or not (entry.isdir() or entry.isfile()) or entry.issym() or entry.islnk()
                    or entry.mode & 0o7000 or entry.size < 0):
                raise ValueError('Unsafe archive member')
            # Case and trailing-dot/space aliases are unsafe on Windows even if
            # this particular extraction happens on Linux.
            for part in parts:
                if part.endswith(('.', ' ')) or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', part, re.I):
                    raise ValueError('Nonportable archive member')
            canonical = '/'.join(parts).casefold()
            if canonical in seen:
                raise ValueError('Duplicate archive member')
            seen.add(canonical)
            total += entry.size
            if total > MAX_BYTES or entry.size > MAX_BYTES:
                raise ValueError('Archive size limit')
        for entry in entries:
            target = root.joinpath(*PurePosixPath(entry.name.rstrip('/')).parts)
            # All members were validated together before any file is created.
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if entry.isdir():
                target.mkdir(mode=0o700, exist_ok=True)
                continue
            reader = source.extractfile(entry)
            if reader is None:
                raise ValueError('Missing archive data')
            with reader, target.open('xb') as output:
                remaining = entry.size
                while remaining:
                    chunk = reader.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError('Truncated archive data')
                    output.write(chunk)
                    remaining -= len(chunk)
            os.chmod(target, 0o755 if entry.mode & 0o111 else 0o644)
    if not (root / 'current' / '.git' / 'HEAD').is_file():
        raise ValueError('Source Git identity missing')

if __name__ == '__main__':
    try:
        extract(sys.argv[1], sys.argv[2])
    except Exception:
        # No archive member names or exception text reaches a public runner log.
        print('Protected source extraction failed.', file=sys.stderr)
        sys.exit(1)
