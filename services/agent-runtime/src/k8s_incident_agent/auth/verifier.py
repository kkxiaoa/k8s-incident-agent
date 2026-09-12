import asyncio
import os
import stat
from pathlib import Path

from argon2 import PasswordHasher, extract_parameters
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from argon2.profiles import RFC_9106_LOW_MEMORY


class OperatorCredentialUnavailableError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("Operator credential is unavailable")


class PasswordVerifier:
    __slots__ = ("_encoded", "_hasher")

    def __init__(self, encoded: str) -> None:
        try:
            if len(encoded.encode("ascii")) > 256:
                raise ValueError
            if extract_parameters(encoded) != RFC_9106_LOW_MEMORY:
                raise ValueError
        except (UnicodeError, ValueError, InvalidHashError):
            raise OperatorCredentialUnavailableError from None
        self._encoded = encoded
        self._hasher = PasswordHasher.from_parameters(RFC_9106_LOW_MEMORY)
        # Parameter extraction is not full PHC validation; exercise native decoding
        # before the Runtime can become ready, without generating a credential.
        self.matches(b"")

    @classmethod
    def from_file(cls, path: Path) -> "PasswordVerifier":
        try:
            resolved = path.resolve(strict=True)
            if not resolved.is_relative_to(path.parent.resolve(strict=True)):
                raise ValueError
            descriptor = os.open(
                resolved, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
            )
            try:
                metadata = os.fstat(descriptor)
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 256:
                    raise ValueError
                encoded = os.read(descriptor, 257).decode("ascii")
            finally:
                os.close(descriptor)
            return cls(encoded.removesuffix("\n"))
        except (OSError, RuntimeError, ValueError, UnicodeError):
            raise OperatorCredentialUnavailableError from None

    def matches(self, password: bytes) -> bool:
        try:
            return self._hasher.verify(self._encoded, password)
        except VerifyMismatchError:
            return False
        except (InvalidHashError, VerificationError):
            raise OperatorCredentialUnavailableError from None

    async def check(self, password: bytes) -> bool:
        return await asyncio.to_thread(self.matches, password)
