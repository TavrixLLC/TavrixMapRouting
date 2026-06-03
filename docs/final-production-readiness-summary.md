# TavrixMap Routing Final Production Readiness Summary

## Final Decision

Routing subsystem decision: GO.

Whole TavrixMap routing-plus-geocoder integration decision: CONDITIONAL GO until the separately operated geocoder URL is provided and `npm run test:geocoder-routing-fixture` passes against a real geocoder response containing `routable_point`.

This repository owns routing only. It does not deploy or modify the geocoder.

## Root Causes Fixed

1. False Valhalla health was fixed. Readiness now fails closed unless graph files, config, Valhalla `/status`, real `/locate`, and real route probes all pass.
2. Missing graph lifecycle was fixed with immutable graph builds, manifests, checksums, validation, staging, activation, rollback, and pruning.
3. Fake snap success was fixed. Offshore or outside-radius points now return `matched:false`, `snapped:null`, and no fake zero-distance edge.
4. Multi-leg route geometry was fixed. All leg shapes are decoded and merged instead of returning only the first leg.
5. Map-match reporting was fixed to use upstream trace attributes and real quality values instead of hard-coded zeroes.
6. API and Valhalla limits were aligned through `config/routing-limits.json` and startup validation.
7. Public exposure was locked down. Only Nginx publishes `:8080`; Valhalla, API, Prometheus, docs, metrics, build endpoints, and dependency health stay internal.
8. Updater security and portability were fixed. No Docker socket mount, scripts use LF endings, updater has a prebuilt tool image, and activation happens on the host.
9. Blue/green activation was made real. The inactive slot is staged and probed before switching traffic, and rollback is one command.
10. Observability was added with Prometheus histograms/gauges, alert rules, Grafana provisioning, graph metadata, and active route probe status.
11. Load testing was added and passed on the real graph.
12. The external geocoder-to-routing fixture command was added, but it requires the separately operated geocoder URL.

## Files Changed

Major changed or added areas:

- `docker-compose.yml`
- `routing-api/src/server.js`
- `routing-api/src/openapi.js`
- `routing-api/test/server.test.js`
- `routing-api/scripts/*.mjs`
- `config/routing-limits.json`
- `config/routing-quality-matrix.json`
- `config/regions/bahrain.json`
- `scripts/*.sh`
- `scripts/*.ps1`
- `updater/`
- `deploy/nginx/routing.conf`
- `monitoring/prometheus/`
- `monitoring/grafana/`
- `docs/`
- `.gitattributes`
- `.gitignore`
- `.env.example`

## Commands Run

Final verification commands:

```bash
npm test
npm run test:scripts
npm run test:routing-quality-matrix
npm run test:route-quality-gate
npm run test:geocoder-routing-fixture
docker compose build routing-api
docker compose --profile updater --profile observability config --services
docker compose --profile updater run --rm --no-deps routing-updater bash -n /opt/tavrix/scripts/*.sh
./scripts/activate-bluegreen.ps1 -Color blue -BuildId valhalla-bahrain-20260602-1758
./scripts/rollback-bluegreen.ps1
./scripts/start-routing-runtime.ps1
git diff --check
```

## Tests Added

Added or expanded tests for:

- readiness fail-closed behavior
- route response schema
- OpenAPI required fields
- multi-leg route geometry
- snap matched/unmatched correctness
- snap radius enforcement
- map-match quality reporting
- route/matrix/isochrone validation
- shell script LF/shebang validation
- real routing quality matrix
- real route load gate
- external geocoder-to-routing fixture command

## Real Graph Validation Result

Graph:

- Build ID: `valhalla-bahrain-20260602-1758`
- Region: Bahrain, built from GCC States PBF
- Tile count: 3,470
- Active slot: green
- Active replicas: 2
- Standby slot: blue
- Standby replicas: 1
- Readiness: PASS

Readiness requires:

- config exists
- active version exists
- graph directory exists
- graph is non-empty
- manifest exists
- graph tiles exist
- Valhalla status OK
- locate probe OK
- route probe OK

## Real Route Examples

Public route request through Nginx:

- Endpoint: `POST http://localhost:8080/api/routing/route`
- Coordinates: `26.2235,50.5876` to `26.2285,50.5860`
- Result: HTTP 200
- Distance: approximately 1.266 km
- Geometry: GeoJSON LineString
- Graph version returned: `valhalla-bahrain-20260602-1758`

Strict quality matrix:

- Result: PASS
- Graph version: `valhalla-bahrain-20260602-1758`
- Route p95: 113 ms
- Failed cases: none

## Real Snap Examples

Near-road snap:

- Expected: matched
- Result: PASS in quality matrix

Offshore snap:

- Endpoint: `POST http://localhost:8080/api/routing/snap`
- Input: `25.55,50.25`
- Result: HTTP 200
- `matched:false`
- `snapped:null`
- `distance_meters:null`
- Reason: outside/no road match, not fake success

## Real Geocoder-To-Routing Test

Command added:

```bash
npm run test:geocoder-routing-fixture
```

Current result:

- Result: FAIL
- Reason: `not_configured`
- Cause: no `GEOCODER_FIXTURE_URL`, no `GEOCODER_BASE_URL`, no geocoder container, and no geocoder source exists in this routing workspace.

To close the integration gate:

```bash
GEOCODER_FIXTURE_URL="http://<geocoder>/..." npm run test:geocoder-routing-fixture
```

The command extracts a real `routable_point` from the geocoder response and routes from a known Bahrain origin to that point through the public routing API.

## Security Changes

- Only reverse proxy publishes a public routing port.
- Valhalla services are internal only.
- Routing API service is internal only.
- Prometheus is internal only.
- Grafana binds to loopback only.
- Public metrics/docs/OpenAPI/build/dependency endpoints return 404.
- Updater no longer mounts Docker socket.
- Images are pinned or versioned.
- Containers use read-only filesystems where practical.
- Resource limits are configured.
- Build endpoints are disabled by default.
- Grafana password is file-backed and local secret is ignored by Git.

## Monitoring Changes

- Prometheus scrape config added.
- Alert rules added.
- Grafana dashboard/provisioning added.
- Metrics include request/upstream histograms.
- Metrics include readiness gauge.
- Metrics include route probe gauge.
- Metrics include active graph info.
- Metrics avoid unbounded route labels.

Final observability checks:

- Prometheus ready: PASS
- Routing target health: up
- Grafana health: PASS
- `routing_ready`: 1
- `routing_route_probe_ok`: 1
- `routing_active_graph_info{version="valhalla-bahrain-20260602-1758",color="green"}`: 1

## Load Gate Result

Final load gate result: PASS.

```text
route_50_rps: p95 88 ms, 0 errors, 0 timeouts
route_100_rps: p95 490 ms, 0 errors, 0 timeouts
snap_100_rps: p95 120 ms, 0 errors, 0 timeouts
matrix_controlled: p95 46 ms, 0 errors, 0 timeouts
isochrone_controlled: p95 669 ms, 0 errors, 0 timeouts
```

The strict route gate target was route p95 under 500 ms at 100 rps. It passed with three active Valhalla replicas, `VALHALLA_SERVICE_CONCURRENCY=2`, a 250 RPS standard route/snap limit, and a 1.0 CPU reverse proxy budget.

## Remaining Launch Blockers

Routing-only launch blockers: none known after final verification.

Whole TavrixMap routing-plus-geocoder launch blocker:

- Provide the separately operated geocoder URL and run `npm run test:geocoder-routing-fixture`.

This is external to the routing repository and cannot be truthfully marked complete without the geocoder endpoint.

## Final Launch Decision

Routing subsystem: GO.

Integrated routing-plus-geocoder workflow: CONDITIONAL GO pending the real geocoder fixture.
