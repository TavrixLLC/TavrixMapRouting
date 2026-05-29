# Valhalla World Graph

This folder is reserved for the optional world routing graph.

Use it only when you decide to build a large `planet-latest.osm.pbf` graph. The Bahrain/regional Valhalla service stays in `valhalla/active/current`; the world service uses:

```text
valhalla/world/data/planet-latest.osm.pbf
valhalla/world/config/valhalla.json
valhalla/world/builds/
valhalla/world/active/current/
```

The world service is disabled by default. Enable it with:

```bash
cd valhalla
VALHALLA_WORLD_URL=http://valhalla-world:8002 docker compose --profile world up -d --build
```

Recommended update frequency:

```text
world graph: monthly, quarterly, or manually when needed
regional graph: daily or weekly for priority markets
```

