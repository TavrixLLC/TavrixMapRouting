#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

PBF_PATH="$(resolve_under_valhalla "${PBF_PATH}")"
CONFIG_PATH="$(resolve_under_valhalla "${CONFIG_PATH}")"
BUILDS_PATH="$(resolve_under_valhalla "${BUILDS_PATH}")"

[[ -f "${PBF_PATH}" ]] || fail "missing PBF file: ${PBF_PATH}"
[[ -s "${PBF_PATH}" ]] || fail "PBF file is empty: ${PBF_PATH}"
[[ -f "${CONFIG_PATH}" ]] || fail "missing config file: ${CONFIG_PATH}"

mkdir -p "${BUILDS_PATH}"

BUILD_STAMP="${VALHALLA_BUILD_STAMP:-$(date -u +%Y%m%d-%H%M)}"
BUILD_ID="${VALHALLA_BUILD_ID:-valhalla-${REGION}-${BUILD_STAMP}}"
BUILD_DIR="${BUILDS_PATH}/${BUILD_ID}"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

[[ ! -e "${BUILD_DIR}" ]] || fail "build already exists: ${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

log "region: ${REGION}"
log "build_id: ${BUILD_ID}"
log "pbf: ${PBF_PATH}"
log "build_dir: ${BUILD_DIR}"

write_metadata "${BUILD_DIR}/metadata.json" "building" "${BUILD_ID}" "${CREATED_AT}"
cp "${CONFIG_PATH}" "${BUILD_DIR}/valhalla.json"

set +e
if command -v valhalla_build_tiles >/dev/null 2>&1 && prepare_local_build_path "${BUILD_DIR}"; then
  valhalla_build_tiles -c "${CONFIG_PATH}" "${PBF_PATH}" 2>&1 | tee "${BUILD_DIR}/build.log"
  BUILD_STATUS="${PIPESTATUS[0]}"
else
  docker run --rm \
    -v "${VALHALLA_DIR}/config:/valhalla/config:ro" \
    -v "$(dirname "${PBF_PATH}"):/valhalla/data:ro" \
    -v "${BUILD_DIR}:/valhalla/build" \
    "${IMAGE}" \
    valhalla_build_tiles -c /valhalla/config/valhalla.json "/valhalla/data/$(basename "${PBF_PATH}")" \
    2>&1 | tee "${BUILD_DIR}/build.log"
  BUILD_STATUS="${PIPESTATUS[0]}"
fi
set -e

if [[ "${BUILD_STATUS}" -ne 0 ]]; then
  write_metadata "${BUILD_DIR}/metadata.json" "failed" "${BUILD_ID}" "${CREATED_AT}" "failed_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fail "graph tile build failed for ${BUILD_ID}"
fi

if command -v valhalla_build_extract >/dev/null 2>&1 && prepare_local_build_path "${BUILD_DIR}"; then
  valhalla_build_extract -c "${CONFIG_PATH}" -v 2>&1 | tee "${BUILD_DIR}/extract.log"
else
  docker run --rm \
    -v "${VALHALLA_DIR}/config:/valhalla/config:ro" \
    -v "${BUILD_DIR}:/valhalla/build" \
    "${IMAGE}" \
    valhalla_build_extract -c /valhalla/config/valhalla.json -v \
    2>&1 | tee "${BUILD_DIR}/extract.log"
fi

write_metadata "${BUILD_DIR}/metadata.json" "built" "${BUILD_ID}" "${CREATED_AT}"
write_manifest "${BUILD_DIR}" "${BUILD_ID}" "${CREATED_AT}" "pending"
ACTIVE_ROOT="$(resolve_under_valhalla "${ACTIVE_ROOT}")"
mkdir -p "${ACTIVE_ROOT}"
printf '%s\n' "${BUILD_ID}" > "${ACTIVE_ROOT}/.last_build_id"
log "built ${BUILD_ID}"
