"""Import only the OS-5 transport files; never execute archive content."""

import hashlib
import re
import stat
import sys
import tarfile
import zipfile
from pathlib import Path

GIB = 1024**3
MAX_ARCHIVE = GIB
MAX_TOTAL = 4 * GIB
MAX_FILES = 4096
PATH = re.compile(
    r"release\.json|(?:console|runtime)-oci/(?:index\.json|oci-layout|blobs/sha256/[a-f0-9]{64})"
)


class BoundedHeader(tarfile.TarInfo):
    @classmethod
    def frombuf(cls, buf, encoding, errors):
        item = super().frombuf(buf, encoding, errors)
        # tarfile processes PAX/GNU metadata before yielding a member to us.
        if not item.isfile() and item.size > 64 * 1024:
            raise ValueError("Oversized archive metadata")
        return item


def copy_file(source, target, size):
    with target.open("xb") as output:
        remaining = size
        while remaining:
            chunk = source.read(min(1024 * 1024, remaining))
            if not chunk:
                raise ValueError("Truncated archive member")
            output.write(chunk)
            remaining -= len(chunk)
        if source.read(1):
            raise ValueError("Archive member exceeded declared size")
    target.chmod(0o600)


def unpack_zip(archive, output):
    if archive.stat().st_size > MAX_ARCHIVE:
        raise ValueError("Oversized artifact")
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        if sorted(item.filename for item in members) != [
            "SHA256SUMS",
            "candidate.tar.gz",
        ]:
            raise ValueError("Unexpected artifact entries")
        for item in members:
            mode = item.external_attr >> 16
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG) or item.flag_bits & 1:
                raise ValueError("Unsupported artifact member")
            limit = 128 if item.filename == "SHA256SUMS" else MAX_ARCHIVE
            if not 0 < item.file_size <= limit:
                raise ValueError("Oversized artifact member")
        output.mkdir(mode=0o700)
        for item in members:
            with bundle.open(item) as source:
                copy_file(source, output / item.filename, item.file_size)


def unpack_tar(transport, output):
    archive = transport / "candidate.tar.gz"
    checksum = transport / "SHA256SUMS"
    if checksum.stat().st_size > 128 or archive.stat().st_size > MAX_ARCHIVE:
        raise ValueError("Oversized transport")
    match = re.fullmatch(r"([a-f0-9]{64})  candidate.tar.gz\n", checksum.read_text())
    with archive.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if not match or match[1] != digest:
        raise ValueError("Transport checksum mismatch")
    output.mkdir(mode=0o700)
    seen = set()
    size = 0
    with tarfile.open(archive, "r|gz", tarinfo=BoundedHeader) as bundle:
        for member in bundle:
            size += member.size
            if (
                not member.isfile()
                or member.issparse()
                or not PATH.fullmatch(member.name)
                or member.name in seen
                or not 0 < member.size <= GIB
                or len(seen) >= MAX_FILES
                or size > MAX_TOTAL
            ):
                raise ValueError("Unsafe or oversized candidate member")
            seen.add(member.name)
            target = output / member.name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with bundle.extractfile(member) as source:
                copy_file(source, target, member.size)
    if "release.json" not in seen:
        raise ValueError("Missing release manifest")


if __name__ == "__main__":
    try:
        action, source, target = sys.argv[1:]
        {"zip": unpack_zip, "tar": unpack_tar}[action](Path(source), Path(target))
    except Exception:
        sys.exit("FAIL release_archive_invalid: unsafe, missing or oversized transport")
