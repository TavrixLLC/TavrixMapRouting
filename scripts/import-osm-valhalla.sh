#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SOURCE_PBF_PATH="$(resolve_source_pbf_path "${SOURCE_PBF_PATH}")"
PBF_PATH="$(resolve_under_valhalla "${PBF_PATH}")"

[[ -f "${SOURCE_PBF_PATH}" ]] || fail "source PBF not found: ${SOURCE_PBF_PATH}"
[[ -s "${SOURCE_PBF_PATH}" ]] || fail "source PBF is empty: ${SOURCE_PBF_PATH}"

SOURCE_SIZE="$(wc -c < "${SOURCE_PBF_PATH}")"
[[ "${SOURCE_SIZE}" -gt 1000000 ]] || fail "source PBF is suspiciously small"

mkdir -p "$(dirname "${PBF_PATH}")"

if [[ "${SOURCE_PBF_PATH}" == "${PBF_PATH}" ]]; then
  log "source PBF is already the Valhalla input: ${PBF_PATH}"
  exit 0
fi

TMP_PBF="${PBF_PATH}.import"
log "importing source PBF: ${SOURCE_PBF_PATH}"
cp "${SOURCE_PBF_PATH}" "${TMP_PBF}"
[[ -s "${TMP_PBF}" ]] || fail "imported PBF is empty"
mv "${TMP_PBF}" "${PBF_PATH}"
log "imported PBF to: ${PBF_PATH}"
