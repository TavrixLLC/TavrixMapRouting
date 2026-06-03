# Quality Gates

Run static and API tests:

```bash
cd routing-api
npm test
npm run test:scripts
```

After activating a real graph:

```bash
npm run test:routing-quality-matrix
npm run test:geocoder-routing-fixture
npm run test:route-quality-gate
```

The strict routing matrix verifies readiness, two real Bahrain routes, a static geocoder-routable fixture, near-road and offshore snap behavior, a small matrix, and an isochrone. It records the active graph identity, Valhalla config digest, failures, and slowest requests in `reports/`.

The load gate exercises route at 50 and 100 requests per second, snap at 100, matrix at 5, and isochrone at 2. It fails for excess p95 latency, timeouts, or error rate.

On the current Bahrain deployment host, the strict 100 rps route gate requires three active Valhalla replicas with `VALHALLA_SERVICE_CONCURRENCY=2`, a 250 RPS standard route/snap rate limit, and enough reverse proxy CPU budget for the public path. Activation applies `VALHALLA_ACTIVE_REPLICAS=3` by default; rerun the load gate after changing replica counts, CPU limits, Valhalla concurrency, rate limits, or proxy resources.

`test:geocoder-routing-fixture` is intentionally external. Set `GEOCODER_FIXTURE_URL` to a real geocoder search or reverse-geocoder fixture that returns `routable_point`, or set `GEOCODER_BASE_URL` plus `GEOCODER_QUERY_TEXT`, `GEOCODER_FOCUS_LAT`, and `GEOCODER_FOCUS_LON`. The command then routes from a known Bahrain origin to the returned routable point and writes `reports/geocoder-routing-fixture.json`.

Use `npm run test:geocoder-routing-fixture:bahrain` for the static Bahrain geocoder-like fixtures. Static fixtures prove extraction and routing behavior, but do not count as a live TavrixMap geocoder integration pass.

For copy-paste-safe Windows PowerShell route and snap checks, see `docs/manual-routing-checks.md`.
