#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

BUILDS_PATH="$(resolve_under_valhalla "${BUILDS_PATH}")"
ACTIVE_BUILD_ID=""
ACTIVE_ROOT="$(resolve_under_valhalla "${ACTIVE_ROOT}")"
if [[ -f "${ACTIVE_ROOT}/.active_build_id" ]]; then
  ACTIVE_BUILD_ID="$(cat "${ACTIVE_ROOT}/.active_build_id")"
elif [[ -f "${ACTIVE_ROOT}/active_version.json" ]]; then
  ACTIVE_BUILD_ID="$(grep '"build_id"' "${ACTIVE_ROOT}/active_version.json" | sed 's/.*: *"//; s/".*//')"
fi

[[ -d "${BUILDS_PATH}" ]] || exit 0

log "pruning builds older than ${RETENTION_DAYS} days; active=${ACTIVE_BUILD_ID:-none}"
find "${BUILDS_PATH}" -mindepth 1 -maxdepth 1 -type d -name "valhalla-${REGION}-*" -mtime +"${RETENTION_DAYS}" | while read -r build_dir; do
  build_id="$(basename "${build_dir}")"
  if [[ "${build_id}" == "${ACTIVE_BUILD_ID}" ]]; then
    log "skip active build ${build_id}"
    continue
  fi
  log "delete old build ${build_id}"
  rm -rf "${build_dir}"
done
