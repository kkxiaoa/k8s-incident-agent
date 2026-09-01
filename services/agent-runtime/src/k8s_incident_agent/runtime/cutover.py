import os

DELETION_CLAIM_DIRECTORY_PREFIX = ".runtime-delete-"
RESET_STAGING_DIRECTORY_PREFIX = ".runtime-reset-stage-"


def require_runtime_cutover_complete(root_fd: int) -> None:
    incomplete_prefixes = (
        DELETION_CLAIM_DIRECTORY_PREFIX,
        RESET_STAGING_DIRECTORY_PREFIX,
    )
    with os.scandir(root_fd) as entries:
        if any(entry.name.startswith(incomplete_prefixes) for entry in entries):
            raise RuntimeError("An incomplete Runtime data cutover remains")
