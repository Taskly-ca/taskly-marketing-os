#!/usr/bin/env bash
# Deploy TMOS to Railway from this laptop — both services, from a clean staging copy.
#
# Why a staging copy and not `railway up .`: the upload must carry `brain/`
# (gitignored, built here from the marketplace checkout because that repo is
# private) and must NOT carry `.env` or node_modules. Copying exactly the
# tracked-or-untracked, non-ignored files plus `brain/` into a temp dir and uploading that with
# --no-gitignore gets both without depending on how Railway reads ignore files.
#
# Usage: scripts/railway-up.sh [console|worker|all]   (default: all)
set -euo pipefail
cd "$(dirname "$0")/.."

TASKLY_REPO_DIR="${TASKLY_REPO_DIR:-$HOME/Documents/Taskly}"
export TASKLY_REPO_DIR
which="${1:-all}"

node scripts/fetch-brain.mjs

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
git ls-files -z --cached --others --exclude-standard | rsync -0a --files-from=- ./ "$stage/"
mkdir -p "$stage/brain"
cp brain/FACT-SHEET.md brain/taskly-brain-snapshot.json "$stage/brain/"
rm -f "$stage/.env" "$stage"/.env.*   # belt and braces: never tracked, never uploaded
echo "staged $(find "$stage" -type f | wc -l | tr -d ' ') files"

deploy() {
  local service="$1"
  echo "── railway up → $service"
  railway up "$stage" --path-as-root --no-gitignore --service "$service" --detach
}

case "$which" in
  console) deploy tmos-console ;;
  worker)  deploy tmos-worker ;;
  all)     deploy tmos-console; deploy tmos-worker ;;
  *) echo "unknown target: $which" >&2; exit 2 ;;
esac
