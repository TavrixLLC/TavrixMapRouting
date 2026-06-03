#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ACTIVE_ROOT="$(resolve_under_valhalla "${ACTIVE_ROOT}")"
VERSION_FILE="${ACTIVE_ROOT}/active_version.json"
[[ -f "${VERSION_FILE}" ]] || fail "active version file is missing"

previous_color="$(grep '"previous"' "${VERSION_FILE}" | sed 's/.*: *"//; s/".*//')"
case "${previous_color}" in
  blue|green) ;;
  *) fail "previous slot is missing from active version file" ;;
esac
BUILD_ID="$(grep '"build_id"' "${ACTIVE_ROOT}/${previous_color}/manifest.json" | sed 's/.*: *"//; s/".*//')"
exec "${SCRIPT_DIR}/activate-bluegreen.sh" "${previous_color}" "${BUILD_ID}"
