# Optional World Graph

The public deployment does not start or build a world graph. Regional requests outside configured Bahrain coverage return a clear `503` unless `VALHALLA_WORLD_URL` points to a separately operated world Valhalla service.

Planet builds are intentionally outside this repository's default Compose stack because their storage, memory, and update requirements are materially larger than the Bahrain graph.
