#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

BUILD_ID="${1:-${VALHALLA_BUILD_ID:-}}"
if [[ -z "${BUILD_ID}" && -f "${VALHALLA_DIR}/.last_build_id" ]]; then
  BUILD_ID="$(cat "${VALHALLA_DIR}/.last_build_id")"
fi
[[ -n "${BUILD_ID}" ]] || fail "usage: validate-valhalla.sh <build-id>"

BUILDS_PATH="$(resolve_under_valhalla "${BUILDS_PATH}")"
BUILD_DIR="${BUILDS_PATH}/${BUILD_ID}"

[[ -d "${BUILD_DIR}" ]] || fail "missing build folder: ${BUILD_DIR}"
[[ -f "${BUILD_DIR}/metadata.json" ]] || fail "missing metadata.json"
[[ -f "${BUILD_DIR}/valhalla_tiles.tar" ]] || fail "missing valhalla_tiles.tar"
[[ -s "${BUILD_DIR}/valhalla_tiles.tar" ]] || fail "empty valhalla_tiles.tar"
grep -q '"/valhalla/build"' "${VALHALLA_DIR}/config/valhalla.json" || fail "config does not reference /valhalla/build"

log "validating ${BUILD_ID}"
route_smoke_test "${BUILD_DIR}" || fail "route smoke test failed"
matrix_smoke_test "${BUILD_DIR}" || fail "matrix smoke test failed"
isochrone_smoke_test "${BUILD_DIR}" || fail "isochrone smoke test failed"

CREATED_AT="$(grep '"created_at"' "${BUILD_DIR}/metadata.json" | sed 's/.*: *"//; s/".*//')"
write_metadata "${BUILD_DIR}/metadata.json" "validated" "${BUILD_ID}" "${CREATED_AT}" "validated_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "${BUILD_ID}" > "${VALHALLA_DIR}/.last_validated_build_id"
log "validated ${BUILD_ID}"
