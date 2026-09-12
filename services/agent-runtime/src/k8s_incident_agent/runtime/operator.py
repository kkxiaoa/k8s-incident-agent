import getpass
import os
import sys
import warnings
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import HashingError
from argon2.profiles import RFC_9106_LOW_MEMORY

from k8s_incident_agent.runtime.artifacts import open_private_directory
from k8s_incident_agent.runtime.paths import PRIVATE_FILE_MODE


def initialize_operator(output: Path) -> int:
    if not output.is_absolute() or not output.name:
        print("--output must name an absolute verifier file path.", file=sys.stderr)
        return 1
    try:
        directory = open_private_directory(output.parent)
    except (OSError, ValueError):
        print(
            "Use an existing private directory (mode 0700) for --output.",
            file=sys.stderr,
        )
        return 1
    try:
        try:
            os.stat(output.name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            print("Output already exists; nothing was overwritten.", file=sys.stderr)
            return 1
        with warnings.catch_warnings():
            # getpass otherwise falls back to reading stdin with echo enabled.
            warnings.simplefilter("error", getpass.GetPassWarning)
            password = getpass.getpass("Set login password (hidden): ").encode("utf-8")
            confirmation = getpass.getpass("Confirm login password (hidden): ").encode(
                "utf-8"
            )
        if not 1 <= len(password) <= 1024 or password != confirmation:
            print(
                "Passwords must match and contain 1-1024 UTF-8 bytes.", file=sys.stderr
            )
            return 1
        encoded = (
            PasswordHasher.from_parameters(RFC_9106_LOW_MEMORY)
            .hash(password)
            .encode("ascii")
        )
        descriptor = os.open(
            output.name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            PRIVATE_FILE_MODE,
            dir_fd=directory,
        )
        try:
            os.fchmod(descriptor, PRIVATE_FILE_MODE)
            remaining = memoryview(encoded)
            while remaining:
                written = os.write(descriptor, remaining)
                if written <= 0:
                    raise OSError
                remaining = remaining[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except (getpass.GetPassWarning, EOFError, KeyboardInterrupt):
        print(
            "Password input cancelled or a non-echoing terminal is unavailable.",
            file=sys.stderr,
        )
        return 1
    except (OSError, ValueError, HashingError):
        print(
            "Initialization failed. If a partial output remains, inspect it before retrying with a new path.",
            file=sys.stderr,
        )
        return 1
    finally:
        os.close(directory)
    print(
        "Verifier created. Use the password you entered to log in; keep it in your password manager."
    )
    return 0
