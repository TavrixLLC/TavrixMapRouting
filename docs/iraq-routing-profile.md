# Iraq Routing Profile

The Iraq routing profile is configured but not production-active.

Do not claim Iraq routing production readiness until a real Iraq graph has been built, validated, activated, and tested with `config/routing-quality-matrix.iraq.json`.

## Region Profile

- Region config: `config/regions/iraq.json`
- PBF source: `https://download.geofabrik.de/asia/iraq-latest.osm.pbf`
- Country codes: `IQ`, `IRQ`
- Bounding box: `38.7,29.0,48.8,37.5`
- Expected active graph prefix: `valhalla-iraq-`
- Build ID format: `valhalla-iraq-YYYYMMDD-HHMM` using UTC timestamps.
- Immutable build path: `builds/valhalla-iraq-<timestamp>`
- Config digest: SHA-256 of `config/valhalla.json`
- Expected smoke-test cities: Baghdad, Basra, Erbil, Najaf, Mosul, Karbala, Sulaymaniyah

The build manifest must include `build_id`, `region_id`, `region_name`, `pbf_source`, `pbf_checksum`, `build_timestamp`, `tile_count`, `total_size_bytes`, `valhalla_config_digest`, and `smoke_test_results`.

The Iraq quality matrix uses real Iraq coordinates only and includes:

- Baghdad focus route near `33.3152,44.3661`, Baghdad city-center route, and Baghdad POI-style route.
- Short urban routes for Basra, Erbil, Najaf, Mosul, Karbala, and Sulaymaniyah.
- Near-road and far/off-road snap checks for every city.
- Route p95 threshold: 500 ms.
- Snap p95 threshold: 250 ms.

## Commands

Run from `routing-api/`:

```bash
npm run graph:build -- --region iraq
npm run graph:validate -- --region iraq --build-id <build-id>
npm run graph:activate -- --region iraq --color blue --build-id <build-id>
```

Activation is host-side and uses the existing blue/green activation script. Use `--color auto` unless you intentionally need a specific slot.

After activation:

```bash
VALHALLA_REGION=iraq
VALHALLA_REGION_CONFIG_PATH=./config/regions/iraq.json
ROUTING_REGION_PATH=/app/config/regions/iraq.json
VALHALLA_IMPORTANT_AREAS=iraq|Iraq|38.7,29.0,48.8,37.5
./scripts/start-routing-runtime.ps1
ROUTING_QUALITY_MATRIX_PATH=config/routing-quality-matrix.iraq.json npm run test:routing-quality-matrix
npm run test:route-quality-gate
```

The Iraq matrix intentionally fails while the active graph is Bahrain. That is the correct behavior.

Do not mark Iraq routing GO unless the real Iraq graph is active and the Iraq quality matrix and load gate pass without raising thresholds. Do not mark the Iraq map product GO unless live TavrixMapGeocoder results provide `properties.routable_point` values that route successfully on the active Iraq graph.
