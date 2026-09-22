"""Real ZIP/TAR counterexamples for the untrusted publication boundary."""

import hashlib
import importlib.util
import io
import stat
import tarfile
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "archive", Path(__file__).with_name("release-archive.py")
)
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.transport = self.root / "transport"
        self.transport.mkdir()

    def make_tar(self, members):
        target = self.transport / "candidate.tar.gz"
        with tarfile.open(target, "w:gz", format=tarfile.PAX_FORMAT) as output:
            for name, kind in members:
                item = tarfile.TarInfo(name)
                item.type = kind
                item.size = 2 if kind == tarfile.REGTYPE else 0
                item.linkname = (
                    "outside" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ""
                )
                output.addfile(item, io.BytesIO(b"{}") if item.size else None)
        checksum = hashlib.sha256(target.read_bytes()).hexdigest()
        (self.transport / "SHA256SUMS").write_text(f"{checksum}  candidate.tar.gz\n")

    def test_regular_files_are_private_and_output_is_never_overwritten(self):
        self.make_tar(
            [
                ("release.json", tarfile.REGTYPE),
                ("console-oci/index.json", tarfile.REGTYPE),
            ]
        )
        output = self.root / "bundle"
        archive.unpack_tar(self.transport, output)
        self.assertEqual((output / "release.json").read_bytes(), b"{}")
        self.assertEqual((output / "release.json").stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            archive.unpack_tar(self.transport, output)

    def test_unsafe_tar_entries_are_rejected(self):
        cases = [
            [("../outside", tarfile.REGTYPE)],
            [("/absolute", tarfile.REGTYPE)],
            [("release.json", tarfile.SYMTYPE)],
            [("release.json", tarfile.LNKTYPE)],
            [("release.json", tarfile.FIFOTYPE)],
            [("private.env", tarfile.REGTYPE)],
            [("release.json", tarfile.REGTYPE), ("release.json", tarfile.REGTYPE)],
            [("console-oci/../release.json", tarfile.REGTYPE)],
            [("console-oci/._index.json", tarfile.REGTYPE)],
        ]
        for index, members in enumerate(cases):
            with self.subTest(members=members):
                self.make_tar(members)
                with self.assertRaises(ValueError):
                    archive.unpack_tar(self.transport, self.root / f"out-{index}")
                self.assertFalse((self.root / "outside").exists())

    def test_checksum_mismatch_stops_before_extraction(self):
        self.make_tar([("release.json", tarfile.REGTYPE)])
        (self.transport / "candidate.tar.gz").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            archive.unpack_tar(self.transport, self.root / "out")
        self.assertFalse((self.root / "out").exists())

    def test_file_budget(self):
        self.make_tar(
            [
                ("release.json", tarfile.REGTYPE),
                ("console-oci/index.json", tarfile.REGTYPE),
            ]
        )
        original = archive.MAX_FILES
        try:
            archive.MAX_FILES = 1
            with self.assertRaises(ValueError):
                archive.unpack_tar(self.transport, self.root / "out")
        finally:
            archive.MAX_FILES = original

    def test_zip_exact_two_entries_and_types(self):
        for index, names in enumerate(
            [
                ["candidate.tar.gz", "SHA256SUMS"],
                ["candidate.tar.gz", "../SHA256SUMS"],
                ["candidate.tar.gz", "SHA256SUMS", "extra"],
                ["candidate.tar.gz", "SHA256SUMS", "SHA256SUMS"],
            ]
        ):
            filename = self.root / f"{index}.zip"
            with zipfile.ZipFile(filename, "w") as output, warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                for name in names:
                    output.writestr(name, b"test")
            if index == 0:
                archive.unpack_zip(filename, self.root / f"zip-{index}")
            else:
                with self.assertRaises(ValueError):
                    archive.unpack_zip(filename, self.root / f"zip-{index}")

    def test_zip_symlink_and_oversized_checksum(self):
        for index, (mode, size) in enumerate([(stat.S_IFLNK, 4), (stat.S_IFREG, 129)]):
            filename = self.root / f"bad-{index}.zip"
            with zipfile.ZipFile(filename, "w") as output:
                output.writestr("candidate.tar.gz", b"fixture")
                item = zipfile.ZipInfo("SHA256SUMS")
                item.create_system = 3
                item.external_attr = (mode | 0o600) << 16
                output.writestr(item, b"x" * size)
            with self.assertRaises(ValueError):
                archive.unpack_zip(filename, self.root / f"bad-{index}")

    def test_pax_metadata_is_bounded_before_tarfile_reads_its_body(self):
        header = tarfile.TarInfo("metadata")
        header.type = tarfile.XHDTYPE
        header.size = 64 * 1024 + 1
        with self.assertRaisesRegex(ValueError, "metadata"):
            archive.BoundedHeader.frombuf(header.tobuf(), "utf-8", "surrogateescape")

    def test_total_unpacked_budget(self):
        self.make_tar([("release.json", tarfile.REGTYPE)])
        original = archive.MAX_TOTAL
        try:
            archive.MAX_TOTAL = 1
            with self.assertRaises(ValueError):
                archive.unpack_tar(self.transport, self.root / "out")
        finally:
            archive.MAX_TOTAL = original


if __name__ == "__main__":
    unittest.main()
