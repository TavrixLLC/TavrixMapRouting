# Security Boundary

The checked-in Compose file exposes only Nginx on `${ROUTING_PUBLIC_PORT:-8080}`. Grafana is optional and loopback-only. Valhalla, the API, Prometheus, metrics, Swagger UI, dependency health, and build operations are internal network services.

Containers run read-only where practical, drop Linux capabilities, set `no-new-privileges`, and define CPU and memory ceilings. The updater mounts graph data directories but never `/var/run/docker.sock`.

Nginx and the API both rate-limit routing traffic:

- route, distance, snap, and nearest: 250 requests per second per client
- matrix, isochrone, map matching, and optimization: 10 requests per second per client

Build endpoints require `ROUTING_INTERNAL_TOKEN` when enabled. They return inert host commands rather than invoking Docker from the API.
