#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BUILD_ID="${1:-}"
[[ -n "${BUILD_ID}" ]] || {
  printf 'usage: switch-active-valhalla.sh <build-id>\n' >&2
  exit 1
}

exec "${SCRIPT_DIR}/activate-bluegreen.sh" auto "${BUILD_ID}"
