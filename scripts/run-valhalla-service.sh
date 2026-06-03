#!/usr/bin/env sh
set -eu

exec valhalla_service "$(cat /valhalla/config/valhalla.json)" "${VALHALLA_SERVICE_CONCURRENCY:-2}"
