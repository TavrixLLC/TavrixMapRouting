# TavrixMap Routing

This repository owns routing only. It runs a Bahrain-focused Valhalla graph behind a normalized API and an Nginx public boundary. It does not change geocoding, POI search, map rendering, PMTiles, or application data.

## Architecture

```text
public :8080 -> nginx -> routing-api -> valhalla-blue or valhalla-green
                                |
                                +-> optional world Valhalla URL

updater profile -> download PBF -> build -> validate
host activation -> stop inactive service -> stage -> health probe -> atomic active_version.json
```

Only Nginx publishes a routing port. Grafana is optional and loopback-only. Valhalla, the API, Prometheus, docs, metrics, and build operations stay on Docker networks.

## First Deployment

Copy `.env.example` to `.env`. Create the Grafana password file only if you enable observability:

```bash
mkdir -p secrets
printf '%s\n' 'replace-with-a-long-random-password' > secrets/grafana_admin_password.txt
```

Build the service images and run the graph pipeline:

```bash
docker compose build routing-api routing-updater
docker compose --profile updater run --rm routing-updater /opt/tavrix/scripts/update-pipeline.sh --build-only
./scripts/activate-bluegreen.ps1 -Color green -BuildId (Get-Content active/.last_validated_build_id -Raw).Trim()
./scripts/start-routing-runtime.ps1
```

The updater image contains Valhalla build tools, Bash, `curl`, `jq`, and `osmium`. It does not mount `/var/run/docker.sock`. Activation intentionally runs on the host because it recreates the inactive Valhalla service after validation.

Activation defaults to `VALHALLA_ACTIVE_REPLICAS=3` and `VALHALLA_STANDBY_REPLICAS=1`. Three active Valhalla replicas with `VALHALLA_SERVICE_CONCURRENCY=2`, a 250 RPS standard route/snap limit, and a 1.0 CPU reverse proxy budget are required for the current Bahrain host to pass the strict 100 rps route latency gate.

## Verification

```bash
curl -fsS http://localhost:8080/health/live
curl -fsS http://localhost:8080/health/ready
cd routing-api
npm test
npm run test:scripts
npm run test:routing-quality-matrix
npm run test:route-quality-gate
```

`/health/ready` fails closed until an active manifest, graph files, Valhalla status, a real locate result, and a real route probe all pass.

Manual Windows PowerShell route and snap examples are in `docs/manual-routing-checks.md`.

## Operations

```bash
# Download/build/validate a candidate
docker compose --profile updater run --rm routing-updater /opt/tavrix/scripts/update-pipeline.sh --build-only

# Stage, verify, and activate the build on the inactive service
./scripts/activate-bluegreen.ps1 -Color auto -BuildId (Get-Content active/.last_validated_build_id -Raw).Trim()

# Refresh API/proxy while preserving active/standby Valhalla replica counts
./scripts/start-routing-runtime.ps1

# Roll back to the retained previous slot
./scripts/rollback-bluegreen.ps1

# Optional monitoring
docker compose --profile observability up -d prometheus grafana
```

The public API is available at `http://localhost:8080/api/routing/...`. OpenAPI, Swagger UI, Prometheus metrics, dependency details, and build endpoints remain internal by design.

## Runbooks

- [Deployment and rollback](docs/deployment.md)
- [Monitoring and alerts](docs/monitoring.md)
- [Security boundary](docs/security.md)
- [Quality gates](docs/quality-gates.md)
- [Known blockers](docs/known-blockers.md)
- [Iraq routing profile](docs/iraq-routing-profile.md)
