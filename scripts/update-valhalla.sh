#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

LOCK_PARENT="$(dirname "${LOCK_DIR}")"
mkdir -p "${LOCK_PARENT}"
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  fail "another Valhalla update is already running"
fi
trap 'rm -rf "${LOCK_DIR}"' EXIT

PBF_PATH="$(resolve_under_valhalla "${PBF_PATH}")"
SOURCE_PBF_PATH="$(resolve_source_pbf_path "${SOURCE_PBF_PATH}")"

if [[ "${DOWNLOAD_PBF}" == "true" ]]; then
  [[ -n "${PBF_URL}" ]] || fail "VALHALLA_PBF_URL is required when VALHALLA_DOWNLOAD_PBF=true"
  TMP_PBF="${PBF_PATH}.download"
  log "downloading PBF to temporary file"
  curl -fL "${PBF_URL}" -o "${TMP_PBF}"
  [[ -s "${TMP_PBF}" ]] || fail "downloaded PBF is empty"
  SIZE_BYTES="$(wc -c < "${TMP_PBF}")"
  [[ "${SIZE_BYTES}" -gt 1000000 ]] || fail "downloaded PBF is suspiciously small"
  mv "${TMP_PBF}" "${PBF_PATH}"
else
  [[ -f "${SOURCE_PBF_PATH}" ]] || fail "source PBF not found: ${SOURCE_PBF_PATH}"
  [[ -s "${SOURCE_PBF_PATH}" ]] || fail "source PBF is empty: ${SOURCE_PBF_PATH}"
  SOURCE_SIZE="$(wc -c < "${SOURCE_PBF_PATH}")"
  [[ "${SOURCE_SIZE}" -gt 1000000 ]] || fail "source PBF is suspiciously small"

  mkdir -p "$(dirname "${PBF_PATH}")"

  if [[ "${SOURCE_PBF_PATH}" == "${PBF_PATH}" ]]; then
    log "using existing local PBF: ${PBF_PATH}"
  else
    TMP_PBF="${PBF_PATH}.import"
    log "importing source PBF: ${SOURCE_PBF_PATH}"
    cp "${SOURCE_PBF_PATH}" "${TMP_PBF}"
    [[ -s "${TMP_PBF}" ]] || fail "imported PBF is empty"
    mv "${TMP_PBF}" "${PBF_PATH}"
    log "imported PBF to: ${PBF_PATH}"
  fi
fi

"${SCRIPT_DIR}/build-valhalla.sh"
BUILD_ID="$(cat "${VALHALLA_DIR}/.last_build_id")"
"${SCRIPT_DIR}/validate-valhalla.sh" "${BUILD_ID}"
"${SCRIPT_DIR}/switch-active-valhalla.sh" "${BUILD_ID}"

if ! "${SCRIPT_DIR}/prune-old-valhalla-builds.sh"; then
  log "warning: prune failed; release remains successful"
fi

log "update completed for ${BUILD_ID}"
