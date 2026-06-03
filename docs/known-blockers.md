# Known Blockers

Production readiness still depends on the unresolved gate below. The real GCC States PBF build, blue/green activation, readiness probe, strict routing quality matrix, strict route load gate, and observability startup have passed on the deployment host.

1. Run one end-to-end geocoder-to-routing fixture against the separately operated geocoder. This repository deliberately does not modify or deploy the geocoder.

Until that check passes, the subsystem is hardened and live-validated, but not release-ready.

The routing repo now includes `npm run test:geocoder-routing-fixture`. It requires `GEOCODER_FIXTURE_URL` or `GEOCODER_BASE_URL`; neither a geocoder container nor a geocoder URL is present in this workspace.

## Current Host Measurement

On June 3, 2026, the warmed load gate passed with three active Valhalla replicas, `VALHALLA_SERVICE_CONCURRENCY=2`, a 250 RPS standard route/snap limit, and a 1.0 CPU reverse proxy budget. The final route-at-100-rps run measured 490 ms p95 against the strict 500 ms target, with zero errors and zero timeouts. Keep `VALHALLA_ACTIVE_REPLICAS=3` and `VALHALLA_SERVICE_CONCURRENCY=2`, or rerun the load gate before approving a lower active replica count or different worker/rate-limit/proxy setting.
