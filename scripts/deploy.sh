#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if ! command -v hugo >/dev/null 2>&1; then
  echo "Hugo is not installed or not on PATH." >&2
  exit 1
fi

hugo --gc --minify

git add -A

git commit -m "Publish site" || true

git push origin main
