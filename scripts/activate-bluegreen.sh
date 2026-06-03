#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

COLOR="${1:-auto}"
BUILD_ID="${2:-}"
ACTIVE_ROOT="$(resolve_under_valhalla "${ACTIVE_ROOT}")"
VERSION_FILE="${ACTIVE_ROOT}/active_version.json"
ACTIVE_REPLICAS="${VALHALLA_ACTIVE_REPLICAS:-3}"
STANDBY_REPLICAS="${VALHALLA_STANDBY_REPLICAS:-1}"

positive_int() {
  [[ "$2" =~ ^[1-9][0-9]*$ ]] || fail "$1 must be a positive integer"
}

wait_service_healthy() {
  local service="$1"
  local expected_replicas="$2"
  local ids status all_healthy
  for _ in $(seq 1 30); do
    mapfile -t ids < <(docker compose ps -q "${service}" | sed '/^$/d')
    if (( ${#ids[@]} >= expected_replicas )); then
      all_healthy=1
      for id in "${ids[@]}"; do
        status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${id}")" || all_healthy=0
        [[ "${status}" == "healthy" ]] || all_healthy=0
      done
      (( all_healthy == 1 )) && return 0
    fi
    sleep 3
  done
  fail "service ${service} did not reach ${expected_replicas} healthy replica(s)"
}

positive_int VALHALLA_ACTIVE_REPLICAS "${ACTIVE_REPLICAS}"
positive_int VALHALLA_STANDBY_REPLICAS "${STANDBY_REPLICAS}"

current_color="blue"
if [[ -f "${VERSION_FILE}" ]]; then
  current_color="$(grep '"active"' "${VERSION_FILE}" | sed 's/.*: *"//; s/".*//')"
fi
inactive_color="green"
[[ "${current_color}" == "green" ]] && inactive_color="blue"
[[ "${COLOR}" == "auto" ]] && COLOR="${inactive_color}"
case "${COLOR}" in
  blue|green) ;;
  *) fail "usage: activate-bluegreen.sh <auto|blue|green> <build-id>" ;;
esac
[[ "${COLOR}" != "${current_color}" ]] || fail "refusing to replace currently active slot ${COLOR}"
[[ -n "${BUILD_ID}" ]] || fail "build-id is required"
[[ "${BUILD_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || fail "build-id contains unsupported characters"

if command -v docker >/dev/null 2>&1; then
  (
    cd "${VALHALLA_DIR}"
    docker compose stop "valhalla-${COLOR}" || true
  )
fi
"${SCRIPT_DIR}/stage-build.sh" "${COLOR}" "${BUILD_ID}"

if command -v docker >/dev/null 2>&1; then
  (
    cd "${VALHALLA_DIR}"
    docker compose up -d --force-recreate "valhalla-${COLOR}"
    wait_service_healthy "valhalla-${COLOR}" 1
    docker compose exec -T "valhalla-${COLOR}" /bin/sh /opt/tavrix/scripts/valhalla-container-health.sh
    docker compose up -d --scale "valhalla-${COLOR}=${ACTIVE_REPLICAS}" "valhalla-${COLOR}"
    wait_service_healthy "valhalla-${COLOR}" "${ACTIVE_REPLICAS}"
    docker compose exec -T "valhalla-${COLOR}" /bin/sh /opt/tavrix/scripts/valhalla-container-health.sh
  )
else
  log "docker is unavailable; staged slot ${COLOR} but did not activate it"
  exit 0
fi

CREATED_AT="$(grep '"build_timestamp"' "${ACTIVE_ROOT}/${COLOR}/manifest.json" | sed 's/.*: *"//; s/".*//')"
CONFIG_SHA="$(grep '"config_sha256"' "${ACTIVE_ROOT}/${COLOR}/manifest.json" | sed 's/.*: *"//; s/".*//')"
TMP_VERSION="${VERSION_FILE}.next"
{
  printf '{\n'
  printf '  "active": "%s",\n' "${COLOR}"
  printf '  "previous": "%s",\n' "${current_color}"
  printf '  "build_id": "%s",\n' "${BUILD_ID}"
  printf '  "created_at": "%s",\n' "${CREATED_AT}"
  printf '  "config_sha256": "%s",\n' "${CONFIG_SHA}"
  printf '  "active_replicas": %s,\n' "${ACTIVE_REPLICAS}"
  printf '  "standby_replicas": %s,\n' "${STANDBY_REPLICAS}"
  printf '  "activated_at": "%s"\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '}\n'
} > "${TMP_VERSION}"
mv "${TMP_VERSION}" "${VERSION_FILE}"
printf '%s\n' "${BUILD_ID}" > "${ACTIVE_ROOT}/.active_build_id"
(
  cd "${VALHALLA_DIR}"
  docker compose up -d --scale "valhalla-${current_color}=${STANDBY_REPLICAS}" "valhalla-${current_color}"
  wait_service_healthy "valhalla-${current_color}" "${STANDBY_REPLICAS}"
)
log "activated ${COLOR} with ${BUILD_ID} using ${ACTIVE_REPLICAS} active replica(s); previous slot ${current_color} remains available with ${STANDBY_REPLICAS} standby replica(s)"
