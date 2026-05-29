#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALHALLA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ROOT="$(cd "${VALHALLA_DIR}/.." && pwd)"

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
PBF_NAME="${VALHALLA_PBF_NAME:-bahrain-latest.osm.pbf}"
IMAGE="${VALHALLA_IMAGE:-ghcr.io/valhalla/valhalla:latest}"
SOURCE_PBF_PATH="${VALHALLA_SOURCE_PBF_PATH:-${PROJECT_ROOT}/osm/${PBF_NAME}}"
PBF_PATH="${VALHALLA_PBF_PATH:-${VALHALLA_DIR}/data/${PBF_NAME}}"
CONFIG_PATH="${VALHALLA_CONFIG_PATH:-${VALHALLA_DIR}/config/valhalla.json}"
BUILDS_PATH="${VALHALLA_BUILDS_PATH:-${VALHALLA_DIR}/builds}"
ACTIVE_PATH="${VALHALLA_ACTIVE_PATH:-${VALHALLA_DIR}/active/current}"
RETENTION_DAYS="${VALHALLA_RETENTION_DAYS:-14}"
LOCK_DIR="${VALHALLA_LOCK_DIR:-${VALHALLA_DIR}/.locks/valhalla-build.lock}"
DOWNLOAD_PBF="${VALHALLA_DOWNLOAD_PBF:-false}"
PBF_URL="${VALHALLA_PBF_URL:-}"
USE_SYMLINK="${VALHALLA_USE_SYMLINK:-auto}"

ROUTE_JSON='{"locations":[{"lat":26.2235,"lon":50.5876},{"lat":26.2285,"lon":50.5860}],"costing":"auto","directions_options":{"units":"kilometers"}}'
MATRIX_JSON='{"sources":[{"lat":26.2235,"lon":50.5876}],"targets":[{"lat":26.2285,"lon":50.5860}],"costing":"auto"}'
ISOCHRONE_JSON='{"locations":[{"lat":26.2235,"lon":50.5876}],"costing":"auto","contours":[{"time":5}],"polygons":true}'

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
  docker run --rm \
    -v "${VALHALLA_DIR}/config:/valhalla/config:ro" \
    -v "${build_dir}:/valhalla/build:ro" \
    "${IMAGE}" \
    sh -c "valhalla_service \"\$(cat /valhalla/config/valhalla.json)\" route '${ROUTE_JSON}'" > "${build_dir}/route-smoke.json"

  grep -q '"length"' "${build_dir}/route-smoke.json" || return 1
  grep -q '"time"' "${build_dir}/route-smoke.json" || return 1
  grep -q '"shape"' "${build_dir}/route-smoke.json" || return 1
}

matrix_smoke_test() {
  local build_dir="$1"
  docker run --rm \
    -v "${VALHALLA_DIR}/config:/valhalla/config:ro" \
    -v "${build_dir}:/valhalla/build:ro" \
    "${IMAGE}" \
    sh -c "valhalla_service \"\$(cat /valhalla/config/valhalla.json)\" sources_to_targets '${MATRIX_JSON}'" > "${build_dir}/matrix-smoke.json"

  grep -q '"sources_to_targets"' "${build_dir}/matrix-smoke.json"
}

isochrone_smoke_test() {
  local build_dir="$1"
  docker run --rm \
    -v "${VALHALLA_DIR}/config:/valhalla/config:ro" \
    -v "${build_dir}:/valhalla/build:ro" \
    "${IMAGE}" \
    sh -c "valhalla_service \"\$(cat /valhalla/config/valhalla.json)\" isochrone '${ISOCHRONE_JSON}'" > "${build_dir}/isochrone-smoke.json"

  grep -q '"features"' "${build_dir}/isochrone-smoke.json"
}
