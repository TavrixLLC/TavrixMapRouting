#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALHALLA_DIR="${VALHALLA_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "${VALHALLA_DIR}/.." && pwd)}"

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

load_env_file() {
  local file="$1"
  if [[ -f "${file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${file}"
    set +a
  fi
}

load_env_file "${PROJECT_ROOT}/.env"
load_env_file "${VALHALLA_DIR}/.env"

REGION="${VALHALLA_REGION:-bahrain}"
REGION_CONFIG_PATH="${VALHALLA_REGION_CONFIG_PATH:-${VALHALLA_DIR}/config/regions/${REGION}.json}"

region_config_value() {
  local filter="$1"
  if [[ -f "${REGION_CONFIG_PATH}" ]] && command -v jq >/dev/null 2>&1; then
    jq -r "${filter} // empty" "${REGION_CONFIG_PATH}"
  fi
}

REGION_NAME="${VALHALLA_REGION_NAME:-$(region_config_value '.name')}"
REGION_NAME="${REGION_NAME:-${REGION}}"
PBF_NAME="${VALHALLA_PBF_NAME:-$(region_config_value '.pbf_name')}"
PBF_NAME="${PBF_NAME:-gcc-states-latest.osm.pbf}"
IMAGE="${VALHALLA_IMAGE:-ghcr.io/valhalla/valhalla@sha256:35362dd5f215a8dd6f19b8dab7b41a85cbf0e743e010b7ccf8f5aa984bf565a1}"
SOURCE_PBF_PATH="${VALHALLA_SOURCE_PBF_PATH:-${PROJECT_ROOT}/osm/${PBF_NAME}}"
PBF_PATH="${VALHALLA_PBF_PATH:-${VALHALLA_DIR}/data/${PBF_NAME}}"
CONFIG_PATH="${VALHALLA_CONFIG_PATH:-${VALHALLA_DIR}/config/valhalla.json}"
BUILDS_PATH="${VALHALLA_BUILDS_PATH:-${VALHALLA_DIR}/builds}"
ACTIVE_ROOT="${VALHALLA_ACTIVE_ROOT:-${VALHALLA_DIR}/active}"
RETENTION_DAYS="${VALHALLA_RETENTION_DAYS:-14}"
LOCK_DIR="${VALHALLA_LOCK_DIR:-${VALHALLA_DIR}/.locks/valhalla-build.lock}"
DOWNLOAD_PBF="${VALHALLA_DOWNLOAD_PBF:-false}"
PBF_URL="${VALHALLA_PBF_URL:-$(region_config_value '.pbf_source')}"
PBF_URL="${PBF_URL:-https://download.geofabrik.de/asia/gcc-states-latest.osm.pbf}"

ROUTE_JSON='{"locations":[{"lat":26.2235,"lon":50.5876},{"lat":26.2285,"lon":50.5860}],"costing":"auto","directions_options":{"units":"kilometers"}}'
LOCATE_JSON='{"locations":[{"lat":26.2235,"lon":50.5876}],"costing":"auto","verbose":true}'
MATRIX_JSON='{"sources":[{"lat":26.2235,"lon":50.5876}],"targets":[{"lat":26.2285,"lon":50.5860}],"costing":"auto"}'
ISOCHRONE_JSON='{"locations":[{"lat":26.2235,"lon":50.5876}],"costing":"auto","contours":[{"time":5}],"polygons":true}'

load_region_smoke_tests() {
  [[ -f "${REGION_CONFIG_PATH}" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  local route_json locate_json matrix_json isochrone_json
  route_json="$(jq -c '((.smoke_tests.routes[0].locations // .probe.route) // empty) as $locations | if ($locations | type) == "array" then {"locations":$locations,"costing":"auto","directions_options":{"units":"kilometers"}} else empty end' "${REGION_CONFIG_PATH}")"
  locate_json="$(jq -c '((.smoke_tests.locates[0].location // .probe.locate) // empty) as $location | if ($location | type) == "object" then {"locations":[$location],"costing":"auto","verbose":true} else empty end' "${REGION_CONFIG_PATH}")"
  matrix_json="$(jq -c '(.smoke_tests.matrix.locations // empty) as $locations | if ($locations | type) == "array" and ($locations | length) >= 2 then {"sources":[ $locations[0] ],"targets":[ $locations[1] ],"costing":"auto"} else empty end' "${REGION_CONFIG_PATH}")"
  isochrone_json="$(jq -c '((.smoke_tests.isochrone.locations[0] // .probe.locate) // empty) as $location | if ($location | type) == "object" then {"locations":[$location],"costing":"auto","contours":[{"time":5}],"polygons":true} else empty end' "${REGION_CONFIG_PATH}")"
  [[ -n "${route_json}" ]] && ROUTE_JSON="${route_json}"
  [[ -n "${locate_json}" ]] && LOCATE_JSON="${locate_json}"
  [[ -n "${matrix_json}" ]] && MATRIX_JSON="${matrix_json}"
  [[ -n "${isochrone_json}" ]] && ISOCHRONE_JSON="${isochrone_json}"
}

load_region_smoke_tests

resolve_under_valhalla() {
  local path="$1"
  if [[ "${path}" = /* ]]; then
    printf '%s\n' "${path}"
  else
    printf '%s/%s\n' "${VALHALLA_DIR}" "${path#./}"
  fi
}

resolve_source_pbf_path() {
  local path="$1"
  if [[ "${path}" = /* ]]; then
    printf '%s\n' "${path}"
  elif [[ "${path}" == ../* ]]; then
    printf '%s/%s\n' "${VALHALLA_DIR}" "${path}"
  else
    printf '%s/%s\n' "${PROJECT_ROOT}" "${path#./}"
  fi
}

log() {
  printf '[valhalla] %s\n' "$*"
}

fail() {
  printf '[valhalla] ERROR: %s\n' "$*" >&2
  exit 1
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

graph_file_count() {
  find "$1" -type f ! -name metadata.json ! -name manifest.json ! -name checksums.sha256 ! -name '*.log' ! -name '*-smoke.json' | wc -l | tr -d ' '
}

graph_size_bytes() {
  find "$1" -type f -printf '%s\n' | awk '{ total += $1 } END { print total + 0 }'
}

graph_files_exist() {
  local build_dir="$1"
  [[ -s "${build_dir}/valhalla_tiles.tar" ]] && return 0
  find "${build_dir}" -type f \( -name '*.gph' -o -name '*.bin' \) -print -quit | grep -q .
}

prepare_local_build_path() {
  local build_dir="$1"
  [[ "${VALHALLA_DIR}" == "/valhalla" ]] || return 1
  if [[ -e /valhalla/build && ! -L /valhalla/build ]]; then
    fail "/valhalla/build exists and is not a symlink"
  fi
  rm -f /valhalla/build
  ln -s "${build_dir}" /valhalla/build
}

write_manifest() {
  local build_dir="$1"
  local build_id="$2"
  local created_at="$3"
  local validation_status="$4"
  local pbf_sha256 config_sha256 file_count size_bytes
  pbf_sha256="$(sha256_file "${PBF_PATH}")"
  config_sha256="$(sha256_file "${CONFIG_PATH}")"
  file_count="$(graph_file_count "${build_dir}")"
  size_bytes="$(graph_size_bytes "${build_dir}")"
  {
    printf '{\n'
    printf '  "region_id": "%s",\n' "$(json_escape "${REGION}")"
    printf '  "region_name": "%s",\n' "$(json_escape "${REGION_NAME}")"
    printf '  "build_id": "%s",\n' "$(json_escape "${build_id}")"
    printf '  "build_timestamp": "%s",\n' "$(json_escape "${created_at}")"
    printf '  "pbf_source": "%s",\n' "$(json_escape "${PBF_URL}")"
    printf '  "pbf_file": "%s",\n' "$(json_escape "${PBF_NAME}")"
    printf '  "pbf_checksum": "%s",\n' "${pbf_sha256}"
    printf '  "pbf_sha256": "%s",\n' "${pbf_sha256}"
    printf '  "valhalla_config_digest": "%s",\n' "${config_sha256}"
    printf '  "config_sha256": "%s",\n' "${config_sha256}"
    printf '  "image": "%s",\n' "$(json_escape "${IMAGE}")"
    printf '  "osm_replication_sequence": "%s",\n' "$(json_escape "${VALHALLA_OSM_REPLICATION_SEQUENCE:-unknown}")"
    printf '  "tile_count": %s,\n' "${file_count}"
    printf '  "graph_file_count": %s,\n' "${file_count}"
    printf '  "total_size_bytes": %s,\n' "${size_bytes}"
    printf '  "graph_size_bytes": %s,\n' "${size_bytes}"
    printf '  "smoke_test_results": {\n'
    printf '    "route": "%s",\n' "$(smoke_status "${build_dir}/route-smoke.json")"
    printf '    "locate": "%s",\n' "$(smoke_status "${build_dir}/locate-smoke.json")"
    printf '    "matrix": "%s",\n' "$(smoke_status "${build_dir}/matrix-smoke.json")"
    printf '    "isochrone": "%s"\n' "$(smoke_status "${build_dir}/isochrone-smoke.json")"
    printf '  },\n'
    printf '  "validation_status": "%s"\n' "$(json_escape "${validation_status}")"
    printf '}\n'
  } > "${build_dir}/manifest.json"
  (
    cd "${build_dir}"
    find . -type f ! -name checksums.sha256 -print0 | sort -z | xargs -0 sha256sum > checksums.sha256
  )
}

smoke_status() {
  local file="$1"
  [[ -s "${file}" ]] && printf 'passed' || printf 'pending'
}

write_metadata() {
  local file="$1"
  local status="$2"
  local build_id="$3"
  local created_at="$4"
  local extra_key="${5:-}"
  local extra_value="${6:-}"
  {
    printf '{\n'
    printf '  "region": "%s",\n' "$(json_escape "${REGION}")"
    printf '  "build_id": "%s",\n' "$(json_escape "${build_id}")"
    printf '  "pbf_file": "%s",\n' "$(json_escape "${PBF_NAME}")"
    printf '  "created_at": "%s",\n' "$(json_escape "${created_at}")"
    printf '  "status": "%s"' "$(json_escape "${status}")"
    if [[ -n "${extra_key}" ]]; then
      printf ',\n  "%s": "%s"\n' "$(json_escape "${extra_key}")" "$(json_escape "${extra_value}")"
    else
      printf '\n'
    fi
    printf '}\n'
  } > "${file}"
}

route_smoke_test() {
  local build_dir="$1"
  if command -v valhalla_service >/dev/null 2>&1 && prepare_local_build_path "${build_dir}"; then
    valhalla_service "$(cat "${CONFIG_PATH}")" route "${ROUTE_JSON}" > "${build_dir}/route-smoke.json"
    grep -q '"length"' "${build_dir}/route-smoke.json" || return 1
    grep -q '"time"' "${build_dir}/route-smoke.json" || return 1
    grep -q '"shape"' "${build_dir}/route-smoke.json" || return 1
    return 0
  fi
  docker run --rm \
    -v "${VALHALLA_DIR}/config:/valhalla/config:ro" \
    -v "${build_dir}:/valhalla/build:ro" \
    "${IMAGE}" \
    sh -c "valhalla_service \"\$(cat /valhalla/config/valhalla.json)\" route '${ROUTE_JSON}'" > "${build_dir}/route-smoke.json"

  grep -q '"length"' "${build_dir}/route-smoke.json" || return 1
  grep -q '"time"' "${build_dir}/route-smoke.json" || return 1
  grep -q '"shape"' "${build_dir}/route-smoke.json" || return 1
}

locate_smoke_test() {
  local build_dir="$1"
  if command -v valhalla_service >/dev/null 2>&1 && prepare_local_build_path "${build_dir}"; then
    valhalla_service "$(cat "${CONFIG_PATH}")" locate "${LOCATE_JSON}" > "${build_dir}/locate-smoke.json"
    grep -Eq '"edges"[[:space:]]*:[[:space:]]*\[[[:space:]]*\{' "${build_dir}/locate-smoke.json"
    return
  fi
  docker run --rm \
    -v "${VALHALLA_DIR}/config:/valhalla/config:ro" \
    -v "${build_dir}:/valhalla/build:ro" \
    "${IMAGE}" \
    sh -c "valhalla_service \"\$(cat /valhalla/config/valhalla.json)\" locate '${LOCATE_JSON}'" > "${build_dir}/locate-smoke.json"

  grep -Eq '"edges"[[:space:]]*:[[:space:]]*\[[[:space:]]*\{' "${build_dir}/locate-smoke.json"
}

matrix_smoke_test() {
  local build_dir="$1"
  if command -v valhalla_service >/dev/null 2>&1 && prepare_local_build_path "${build_dir}"; then
    valhalla_service "$(cat "${CONFIG_PATH}")" sources_to_targets "${MATRIX_JSON}" > "${build_dir}/matrix-smoke.json"
    grep -q '"sources_to_targets"' "${build_dir}/matrix-smoke.json"
    return
  fi
  docker run --rm \
    -v "${VALHALLA_DIR}/config:/valhalla/config:ro" \
    -v "${build_dir}:/valhalla/build:ro" \
    "${IMAGE}" \
    sh -c "valhalla_service \"\$(cat /valhalla/config/valhalla.json)\" sources_to_targets '${MATRIX_JSON}'" > "${build_dir}/matrix-smoke.json"

  grep -q '"sources_to_targets"' "${build_dir}/matrix-smoke.json"
}

isochrone_smoke_test() {
  local build_dir="$1"
  if command -v valhalla_service >/dev/null 2>&1 && prepare_local_build_path "${build_dir}"; then
    valhalla_service "$(cat "${CONFIG_PATH}")" isochrone "${ISOCHRONE_JSON}" > "${build_dir}/isochrone-smoke.json"
    grep -q '"features"' "${build_dir}/isochrone-smoke.json"
    return
  fi
  docker run --rm \
    -v "${VALHALLA_DIR}/config:/valhalla/config:ro" \
    -v "${build_dir}:/valhalla/build:ro" \
    "${IMAGE}" \
    sh -c "valhalla_service \"\$(cat /valhalla/config/valhalla.json)\" isochrone '${ISOCHRONE_JSON}'" > "${build_dir}/isochrone-smoke.json"

  grep -q '"features"' "${build_dir}/isochrone-smoke.json"
}
