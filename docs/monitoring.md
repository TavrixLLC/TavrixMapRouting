# Monitoring

Start the optional stack:

```bash
docker compose --profile observability up -d prometheus grafana
```

Grafana binds to `127.0.0.1:3001`. Its admin password comes from `secrets/grafana_admin_password.txt`; no default plaintext password is checked in.

Prometheus scrapes the internal routing API. The dashboard and alerts cover:

- readiness and active graph identity
- route probe availability
- request and upstream latency histograms
- upstream error totals
- snap matched versus unmatched results
- graph age

Treat readiness, route probe, and upstream-error alerts as release blockers. Investigate graph age before the regional PBF becomes operationally stale.
