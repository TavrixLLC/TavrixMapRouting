#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

MODE="${1:---build-only}"
case "${MODE}" in
  --build-only|--dry-run|--activate) ;;
  *) fail "usage: update-pipeline.sh [--dry-run|--build-only|--activate]" ;;
esac

LOCK_PARENT="$(dirname "${LOCK_DIR}")"
mkdir -p "${LOCK_PARENT}"
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  fail "another Valhalla update is already running; remove stale lock only after verifying no build is active"
fi
trap 'rm -rf "${LOCK_DIR}"' EXIT

PBF_PATH="$(resolve_under_valhalla "${PBF_PATH}")"
mkdir -p "$(dirname "${PBF_PATH}")"

if [[ "${DOWNLOAD_PBF}" == "true" || ! -s "${PBF_PATH}" ]]; then
  [[ -n "${PBF_URL}" ]] || fail "VALHALLA_PBF_URL is required"
  TMP_PBF="${PBF_PATH}.download"
  log "downloading ${PBF_URL}"
  curl --fail --location --retry 3 --retry-delay 3 "${PBF_URL}" -o "${TMP_PBF}"
  [[ -s "${TMP_PBF}" ]] || fail "downloaded PBF is empty"
  mv "${TMP_PBF}" "${PBF_PATH}"
fi

[[ -s "${PBF_PATH}" ]] || fail "PBF is missing: ${PBF_PATH}"
PBF_SIZE="$(wc -c < "${PBF_PATH}")"
[[ "${PBF_SIZE}" -gt 1000000 ]] || fail "PBF is suspiciously small"
log "PBF sha256=$(sha256_file "${PBF_PATH}") bytes=${PBF_SIZE}"

if [[ "${MODE}" == "--dry-run" ]]; then
  log "dry-run passed: config and PBF inputs are available"
  exit 0
fi

"${SCRIPT_DIR}/build-valhalla.sh"
ACTIVE_ROOT="$(resolve_under_valhalla "${ACTIVE_ROOT}")"
BUILD_ID="$(cat "${ACTIVE_ROOT}/.last_build_id")"
"${SCRIPT_DIR}/validate-valhalla.sh" "${BUILD_ID}"

ACTIVE_VERSION="${ACTIVE_ROOT}/active_version.json"
active_color="blue"
[[ -f "${ACTIVE_VERSION}" ]] && active_color="$(grep '"active"' "${ACTIVE_VERSION}" | sed 's/.*: *"//; s/".*//')"
inactive_color="green"
[[ "${active_color}" == "green" ]] && inactive_color="blue"
log "candidate ${BUILD_ID} validated; stage and activate inactive slot ${inactive_color} from the host with:"
log "./scripts/activate-bluegreen.sh ${inactive_color} ${BUILD_ID}"
log "PowerShell: ./scripts/activate-bluegreen.ps1 -Color ${inactive_color} -BuildId ${BUILD_ID}"
[[ "${MODE}" != "--activate" ]] || log "--activate is host-only; updater intentionally has no Docker socket access"

"${SCRIPT_DIR}/prune-old-valhalla-builds.sh" || log "warning: prune failed"
