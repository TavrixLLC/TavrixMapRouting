#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

COLOR="${1:-}"
BUILD_ID="${2:-}"
case "${COLOR}" in
  blue|green) ;;
  *) fail "usage: stage-build.sh <blue|green> <build-id>" ;;
esac
[[ -n "${BUILD_ID}" ]] || fail "usage: stage-build.sh <blue|green> <build-id>"
[[ "${BUILD_ID}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || fail "build-id contains unsupported characters"

BUILDS_PATH="$(resolve_under_valhalla "${BUILDS_PATH}")"
ACTIVE_ROOT="$(resolve_under_valhalla "${ACTIVE_ROOT}")"
TARGET="${BUILDS_PATH}/${BUILD_ID}"
SLOT="${ACTIVE_ROOT}/${COLOR}"
NEXT="${ACTIVE_ROOT}/${COLOR}.next"
PREVIOUS="${ACTIVE_ROOT}/${COLOR}.previous"

[[ -d "${TARGET}" ]] || fail "target build does not exist: ${TARGET}"
grep -q '"status": "validated"' "${TARGET}/metadata.json" || fail "target build has not passed validation"
grep -q '"validation_status": "validated"' "${TARGET}/manifest.json" || fail "target manifest is not validated"

mkdir -p "${ACTIVE_ROOT}"
rm -rf "${NEXT}"
cp -a "${TARGET}" "${NEXT}"
rm -rf "${PREVIOUS}"
if [[ -e "${SLOT}" ]]; then
  mv "${SLOT}" "${PREVIOUS}"
fi
mv "${NEXT}" "${SLOT}"
rm -rf "${PREVIOUS}"
log "staged ${BUILD_ID} into inactive slot ${COLOR}"
