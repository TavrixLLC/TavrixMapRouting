# Valhalla Routing Subsystem

This folder contains the complete Valhalla routing subsystem for the Bahrain/regional graph, plus an optional world graph slot.

Valhalla is used only for routing, ETA, matrix, isochrones, and future map matching. It does not render maps, generate PMTiles, geocode text, search POIs, read realtime business data, or read from PostGIS directly.

## Structure

```text
valhalla/
|-- data/
|   `-- bahrain-latest.osm.pbf
|-- config/
|   `-- valhalla.json
|-- builds/
|   `-- valhalla-bahrain-YYYYMMDD-HHMM/
|-- active/
|   `-- current/
|-- scripts/
|   |-- build-valhalla.sh
|   |-- validate-valhalla.sh
|   |-- switch-active-valhalla.sh
|   |-- update-valhalla.sh
|   `-- prune-old-valhalla-builds.sh
|-- routing-api/
|-- frontend/
|-- world/
|   |-- data/
|   |-- config/
|   |-- builds/
|   `-- active/
|-- docker-compose.yml
`-- README.md
```

## Workflow

```text
bahrain-latest.osm.pbf
  -> versioned Valhalla graph build
  -> validation
  -> active switch
  -> Valhalla service
  -> backend routing API
  -> frontend route display
```

## Commands

Run from Git Bash or WSL on Windows.

```bash
cd valhalla
chmod +x scripts/*.sh
./scripts/build-valhalla.sh
./scripts/validate-valhalla.sh
./scripts/switch-active-valhalla.sh "$(cat .last_validated_build_id)"
docker compose up -d --build valhalla routing-api
```

Full update flow:

```bash
cd valhalla
./scripts/update-valhalla.sh
```

If you import or replace the root OSM file here:

```text
osm/bahrain-latest.osm.pbf
```

the update script will automatically copy it into:

```text
valhalla/data/bahrain-latest.osm.pbf
```

before building the new routing graph. You can also run only the import step:

```bash
cd valhalla
./scripts/import-osm-valhalla.sh
```

Rollback:

```bash
cd valhalla
./scripts/switch-active-valhalla.sh valhalla-bahrain-previous-build-id
```

Optional world graph:

```text
valhalla/world/
```

The world graph is disabled by default because planet builds are expensive. After you build and activate a planet graph under `world/active/current`, start the optional service with:

```bash
cd valhalla
VALHALLA_WORLD_URL=http://valhalla-world:8002 docker compose --profile world up -d --build
```

The routing API chooses automatically:

```text
inside regional bounds -> regional Valhalla
outside regional bounds -> world Valhalla if configured
outside regional bounds and world unavailable -> clear 503 error
```

Important areas are configurable through:

```env
VALHALLA_IMPORTANT_AREAS=bahrain|Bahrain|50.2,25.5,51.0,26.6
```

For multiple areas:

```env
VALHALLA_IMPORTANT_AREAS=bahrain|Bahrain|50.2,25.5,51.0,26.6;gcc|GCC|34.0,12.0,60.0,32.5
```

Only configure areas covered by the active regional graph.

## Tests

Swagger UI:

```text
http://localhost:3000/api/routing/docs
```

OpenAPI JSON:

```text
http://localhost:3000/api/routing/openapi.json
```

Mapbox-like directions:

```bash
curl "http://localhost:3000/api/routing/directions/auto/50.5876,26.2235;50.5860,26.2285?units=kilometers&steps=true&area=bahrain"
```

Additional internal routing endpoints:

```text
POST /api/routing/snap
POST /api/routing/nearest
POST /api/routing/distance
POST /api/routing/optimization
GET  /api/routing/health/live
GET  /api/routing/health/ready
GET  /api/routing/health/dependencies
```

Build operations are internal-only and should be protected in production:

```env
ROUTING_INTERNAL_TOKEN=change-me
```

Without `ROUTING_INTERNAL_TOKEN`, build endpoints return `503 internal_token_missing` instead of being public.

Metrics:

```text
http://localhost:3000/metrics
```

Raw upstream responses are off by default:

```env
ROUTING_INCLUDE_RAW=false
ROUTING_ALLOW_REQUEST_RAW=false
```

The OpenAPI contract includes reusable `Geometry`, `Maneuver`, `Bounds`, and `DependencyStatus` schemas. Build endpoints always require an internal token and fail closed when `ROUTING_INTERNAL_TOKEN` is missing.

```bash
curl http://localhost:3000/api/routing/health
```

```bash
curl -X POST http://localhost:3000/api/routing/route \
  -H "Content-Type: application/json" \
  -d '{
    "locations": [
      { "lat": 26.2235, "lon": 50.5876 },
      { "lat": 26.2285, "lon": 50.5860 }
    ],
    "costing": "auto",
    "units": "kilometers"
  }'
```

PowerShell request:

```powershell
$body = @{
  locations = @(
    @{ lat = 26.2235; lon = 50.5876 },
    @{ lat = 26.2285; lon = 50.5860 }
  )
  costing = "auto"
  units = "kilometers"
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "http://localhost:3000/api/routing/route" -Method Post -ContentType "application/json" -Body $body
```

See `../docs/valhalla.md` for the detailed operational guide.
