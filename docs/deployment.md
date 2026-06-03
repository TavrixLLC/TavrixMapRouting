# Deployment And Rollback

## Update Flow

1. Run `docker compose --profile updater run --rm routing-updater /opt/tavrix/scripts/update-pipeline.sh --build-only`.
2. Inspect the generated manifest under `builds/<build-id>/manifest.json`.
3. Activate on Windows with `./scripts/activate-bluegreen.ps1 -Color auto -BuildId (Get-Content active/.last_validated_build_id -Raw).Trim()`. Linux hosts use `./scripts/activate-bluegreen.sh auto "$(cat active/.last_validated_build_id)"`.
4. Start or refresh the API boundary with `./scripts/start-routing-runtime.ps1`. Linux hosts use `./scripts/start-routing-runtime.sh`.
5. Require `curl -fsS http://localhost:8080/health/ready` and the quality gates before accepting traffic.

The updater downloads the configured PBF when no local input exists, records PBF and config hashes, builds a versioned graph, and executes route/locate/matrix/isochrone smoke checks. Host activation stops the inactive service, stages only a validated candidate, and verifies it before switching traffic.

Activation recreates only the inactive `valhalla-blue` or `valhalla-green` service, runs the in-container graph probe, scales the candidate to `VALHALLA_ACTIVE_REPLICAS` replicas, then atomically changes `active/active_version.json`. The prior slot stays available and is scaled to `VALHALLA_STANDBY_REPLICAS`.

The default replica policy is three active Valhalla replicas and one standby replica:

```bash
VALHALLA_ACTIVE_REPLICAS=3
VALHALLA_STANDBY_REPLICAS=1
```

Keep the active count at three or higher unless a fresh `npm run test:route-quality-gate` run proves that a smaller active pool still meets the route-at-100-rps p95 target.

Avoid plain `docker compose up -d routing-api reverse-proxy` for runtime refreshes. Compose can reconcile scaled services back to one replica through dependencies. Use `start-routing-runtime` so the recorded active/standby replica policy is applied every time.

## Rollback

```bash
./scripts/rollback-bluegreen.ps1
curl -fsS http://localhost:8080/health/ready
cd routing-api && npm run test:routing-quality-matrix
cd routing-api && npm run test:route-quality-gate
```

If readiness fails, keep the prior active slot and investigate the candidate manifest and container logs. Do not point traffic at an unvalidated graph.

## Stale Containers

After moving an older installation to this Compose file:

```bash
docker compose down --remove-orphans
./scripts/start-routing-runtime.ps1
```

This removes containers from obsolete Compose definitions, including any updater that mounted Docker socket access.
