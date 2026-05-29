#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

BUILD_ID="${1:-}"
[[ -n "${BUILD_ID}" ]] || fail "usage: switch-active-valhalla.sh <build-id>"

BUILDS_PATH="$(resolve_under_valhalla "${BUILDS_PATH}")"
ACTIVE_PATH="$(resolve_under_valhalla "${ACTIVE_PATH}")"
TARGET="${BUILDS_PATH}/${BUILD_ID}"
PREVIOUS_BACKUP="${ACTIVE_PATH}.previous"
NEXT_PATH="${ACTIVE_PATH}.next"

[[ -d "${TARGET}" ]] || fail "target build does not exist: ${TARGET}"
grep -q '"status": "validated"' "${TARGET}/metadata.json" || fail "target build has not passed validation"

mkdir -p "$(dirname "${ACTIVE_PATH}")"
rm -rf "${NEXT_PATH}"

stop_services_for_switch() {
  if command -v docker >/dev/null 2>&1 && [[ "${VALHALLA_SKIP_RESTART:-false}" != "true" ]]; then
    log "stopping Valhalla services before active graph switch"
    (cd "${VALHALLA_DIR}" && docker compose stop valhalla routing-api) || true
  fi
}

restore_previous() {
  if [[ -d "${PREVIOUS_BACKUP}" ]]; then
    rm -rf "${ACTIVE_PATH}"
    mv "${PREVIOUS_BACKUP}" "${ACTIVE_PATH}"
  fi
}

log "switching active graph to ${BUILD_ID}"

stop_services_for_switch

if [[ "${USE_SYMLINK}" == "true" ]]; then
  ln -sfn "../builds/${BUILD_ID}" "${NEXT_PATH}"
  rm -rf "${PREVIOUS_BACKUP}"
  if [[ -e "${ACTIVE_PATH}" || -L "${ACTIVE_PATH}" ]]; then
    mv "${ACTIVE_PATH}" "${PREVIOUS_BACKUP}"
  fi
  mv -f "${NEXT_PATH}" "${ACTIVE_PATH}"
else
  cp -a "${TARGET}" "${NEXT_PATH}"
  rm -rf "${PREVIOUS_BACKUP}"
  if [[ -d "${ACTIVE_PATH}" || -L "${ACTIVE_PATH}" ]]; then
    mv "${ACTIVE_PATH}" "${PREVIOUS_BACKUP}"
  fi
  mv "${NEXT_PATH}" "${ACTIVE_PATH}"
fi

if command -v docker >/dev/null 2>&1 && [[ "${VALHALLA_SKIP_RESTART:-false}" != "true" ]]; then
  if ! (cd "${VALHALLA_DIR}" && docker compose up -d --build valhalla routing-api); then
    log "restart failed; restoring previous active build"
    restore_previous
    (cd "${VALHALLA_DIR}" && docker compose up -d valhalla routing-api) || true
    fail "Valhalla restart failed after switch"
  fi

  sleep 2
  if ! curl -fsS "http://localhost:${VALHALLA_PORT:-8002}/status" >/dev/null; then
    log "health check failed; restoring previous active build"
    restore_previous
    (cd "${VALHALLA_DIR}" && docker compose up -d valhalla routing-api) || true
    fail "Valhalla health check failed after switch"
  fi
fi

printf '%s\n' "${BUILD_ID}" > "${VALHALLA_DIR}/.active_build_id"
rm -rf "${PREVIOUS_BACKUP}"
log "active graph switched to ${BUILD_ID}"
