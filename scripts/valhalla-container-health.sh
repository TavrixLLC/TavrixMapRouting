#!/bin/sh
set -eu

CONFIG_PATH="${VALHALLA_CONFIG_PATH:-/valhalla/config/valhalla.json}"
BUILD_PATH="${VALHALLA_BUILD_PATH:-/valhalla/build}"
LOCATE_JSON="${VALHALLA_HEALTH_LOCATE_JSON:-}"
ROUTE_JSON="${VALHALLA_HEALTH_ROUTE_JSON:-}"

test -s "${CONFIG_PATH}"
test -d "${BUILD_PATH}"
test -s "${BUILD_PATH}/manifest.json"

REGION_ID="$(sed -n 's/.*"region_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${BUILD_PATH}/manifest.json" | head -n 1)"
if test -z "${LOCATE_JSON}"; then
  case "${REGION_ID}" in
    iraq) LOCATE_JSON='{"locations":[{"lat":33.3152,"lon":44.3661}],"costing":"auto","verbose":true}' ;;
    *) LOCATE_JSON='{"locations":[{"lat":26.2235,"lon":50.5876}],"costing":"auto","verbose":true}' ;;
  esac
fi
if test -z "${ROUTE_JSON}"; then
  case "${REGION_ID}" in
    iraq) ROUTE_JSON='{"locations":[{"lat":33.3152,"lon":44.3661},{"lat":33.3026,"lon":44.3838}],"costing":"auto"}' ;;
    *) ROUTE_JSON='{"locations":[{"lat":26.2235,"lon":50.5876},{"lat":26.2285,"lon":50.5860}],"costing":"auto"}' ;;
  esac
fi

if ! test -s "${BUILD_PATH}/valhalla_tiles.tar"; then
  find "${BUILD_PATH}" -type f \( -name '*.gph' -o -name '*.bin' \) -print -quit | grep -q .
fi

CONFIG_JSON="$(cat "${CONFIG_PATH}")"
valhalla_service "${CONFIG_JSON}" status '{}' >/tmp/valhalla-status.json
valhalla_service "${CONFIG_JSON}" locate "${LOCATE_JSON}" >/tmp/valhalla-locate.json
grep -Eq '"edges"[[:space:]]*:[[:space:]]*\[[[:space:]]*\{' /tmp/valhalla-locate.json
valhalla_service "${CONFIG_JSON}" route "${ROUTE_JSON}" >/tmp/valhalla-route.json
grep -q '"shape"' /tmp/valhalla-route.json
grep -q '"length"' /tmp/valhalla-route.json
grep -q '"time"' /tmp/valhalla-route.json
