import errno
import fcntl
import os
import stat
from pathlib import Path

from k8s_incident_agent.runtime.paths import PRIVATE_FILE_MODE


class RuntimeLockUnavailableError(RuntimeError):
    pass


class RuntimeLock:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._file_descriptor: int | None = None

    def acquire(self) -> None:
        if self._file_descriptor is not None:
            raise RuntimeError("Runtime lock is already held by this instance")

        flags = os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW
        try:
            file_descriptor = os.open(
                self._path,
                flags | os.O_CREAT | os.O_EXCL,
                PRIVATE_FILE_MODE,
            )
            created = True
        except FileExistsError:
            try:
                file_descriptor = os.open(self._path, flags)
                created = False
            except OSError as error:
                if error.errno == errno.ELOOP:
                    raise ValueError(
                        "Runtime lock must not be a symbolic link"
                    ) from error
                raise

        try:
            if created:
                os.fchmod(file_descriptor, PRIVATE_FILE_MODE)
            file_stat = os.fstat(file_descriptor)
            if (
                not stat.S_ISREG(file_stat.st_mode)
                or stat.S_IMODE(file_stat.st_mode) != PRIVATE_FILE_MODE
            ):
                raise ValueError("Runtime lock must be a private regular file")
            try:
                fcntl.flock(file_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN):
                    raise
                raise RuntimeLockUnavailableError(
                    "Runtime data directory is already in use"
                ) from error
        except BaseException:
            os.close(file_descriptor)
            raise

        self._file_descriptor = file_descriptor

    def release(self) -> None:
        file_descriptor = self._file_descriptor
        if file_descriptor is None:
            return
        self._file_descriptor = None
        try:
            fcntl.flock(file_descriptor, fcntl.LOCK_UN)
        finally:
            os.close(file_descriptor)
