#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

start_observability=0
for arg in "$@"; do
  case "${arg}" in
    --observability) start_observability=1 ;;
    *) fail "unknown argument: ${arg}" ;;
  esac
done

ACTIVE_ROOT="$(resolve_under_valhalla "${ACTIVE_ROOT}")"
VERSION_FILE="${ACTIVE_ROOT}/active_version.json"
[[ -f "${VERSION_FILE}" ]] || fail "active version file is missing. Run activate-bluegreen before starting the runtime."

json_string_value() {
  grep "\"$1\"" "${VERSION_FILE}" | sed 's/.*: *"//; s/".*//'
}

json_number_value() {
  grep "\"$1\"" "${VERSION_FILE}" | sed 's/.*: *//; s/,.*//; s/[^0-9].*//'
}

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

wait_routing_ready() {
  local port="${ROUTING_PUBLIC_PORT:-8080}"
  local url="http://localhost:${port}/health/ready"
  for _ in $(seq 1 30); do
    if curl -fsS "${url}"; then
      echo
      return 0
    fi
    sleep 3
  done
  fail "routing API did not become ready at ${url}"
}

active_color="$(json_string_value active)"
case "${active_color}" in
  blue|green) ;;
  *) fail "active slot is missing from active version file" ;;
esac
previous_color="$(json_string_value previous || true)"
case "${previous_color}" in
  blue|green) ;;
  *) previous_color="green"; [[ "${active_color}" == "green" ]] && previous_color="blue" ;;
esac

active_replicas="$(json_number_value active_replicas || true)"
standby_replicas="$(json_number_value standby_replicas || true)"
active_replicas="${active_replicas:-${VALHALLA_ACTIVE_REPLICAS:-3}}"
standby_replicas="${standby_replicas:-${VALHALLA_STANDBY_REPLICAS:-1}}"
positive_int VALHALLA_ACTIVE_REPLICAS "${active_replicas}"
positive_int VALHALLA_STANDBY_REPLICAS "${standby_replicas}"

(
  cd "${VALHALLA_DIR}"
  docker compose up -d \
    --scale "valhalla-${active_color}=${active_replicas}" \
    --scale "valhalla-${previous_color}=${standby_replicas}" \
    "valhalla-${active_color}" \
    "valhalla-${previous_color}" \
    routing-api \
    reverse-proxy
  wait_service_healthy "valhalla-${active_color}" "${active_replicas}"
  wait_service_healthy "valhalla-${previous_color}" "${standby_replicas}"
  if (( start_observability == 1 )); then
    docker compose --profile observability up -d prometheus grafana
  fi
  wait_routing_ready
  docker compose ps
)
log "runtime is up with active valhalla-${active_color}=${active_replicas} and standby valhalla-${previous_color}=${standby_replicas}"
