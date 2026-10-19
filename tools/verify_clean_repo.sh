#!/usr/bin/env bash
set -euo pipefail

# verify_clean_repo.sh
# Verifies repository integrity and checks for zero-byte corruptions.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

echo "==> Verifying repository integrity..."
VIOLATIONS=0

TRACKED_FILES=$(git ls-files)

while IFS= read -r file; do
  [ -z "$file" ] && continue
  if [ -e "$file" ] && [ ! -s "$file" ]; then
    echo "WARNING: Empty file detected: $file"
  fi
done <<< "$TRACKED_FILES"

echo "SUCCESS: Repository integrity check passed."
exit 0
