#!/usr/bin/env bash
set -euo pipefail

# These tools run only on the hosted Linux x64 documentation/security job.
tool_dir="${RUNNER_TEMP:?}/incident-ci-tools"
mkdir -p "$tool_dir"
curl --fail --silent --show-error --location --retry 3 \
  https://github.com/rhysd/actionlint/releases/download/v1.7.11/actionlint_1.7.11_linux_amd64.tar.gz \
  --output "$tool_dir/actionlint.tar.gz"
curl --fail --silent --show-error --location --retry 3 \
  https://github.com/gitleaks/gitleaks/releases/download/v8.30.0/gitleaks_8.30.0_linux_x64.tar.gz \
  --output "$tool_dir/gitleaks.tar.gz"
(
  cd "$tool_dir"
  printf '%s\n' \
    '900919a84f2229bac68ca9cd4103ea297abc35e9689ebb842c6e34a3d1b01b0a  actionlint.tar.gz' \
    '79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e  gitleaks.tar.gz' \
    | sha256sum --check --strict
  tar -xzf actionlint.tar.gz actionlint
  tar -xzf gitleaks.tar.gz gitleaks
)
printf '%s\n' "$tool_dir" >> "$GITHUB_PATH"
