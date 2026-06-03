# Frontend Map Routing QA

This is the manual final QA checklist for the TavrixMap Iraq map product. It requires a live TavrixMapGeocoder service and the live Iraq routing backend. It is not an automated browser test.

## Preconditions

- TavrixMapGeocoder is healthy at `http://localhost:4000/health/ready`.
- TavrixMapRouting is healthy at `http://localhost:8080/health/ready`.
- Routing active build is `valhalla-iraq-20260603-1241`.
- Search results must use `properties.routable_point` when present. Do not fall back to `center` when `routable_point` exists.

## Manual Steps

1. Start the geocoder using its existing compose/scripts.
2. Start Iraq routing and confirm `/health/ready` reports `active_build=valhalla-iraq-20260603-1241`.
3. Open the frontend.
4. Search `مطعم` near Baghdad with focus point `33.3152,44.3661`.
5. Select result A and record its label, country, center, and `properties.routable_point`.
6. Search `فندق` or `مستشفى` near Baghdad.
7. Select result B and record its label, country, center, and `properties.routable_point`.
8. Route A `properties.routable_point` to B `properties.routable_point`.
9. Confirm the frontend draws a route polyline.
10. Confirm distance and duration are visible.
11. Confirm the route stays within Baghdad/Iraq.
12. Try an off-road point and verify snap fails honestly instead of silently moving to a road outside the configured radius.
13. Try a multi-stop route if the UI supports it.
14. Record pass/fail, screenshots if available, and any console/network errors.

## Pass Criteria

- Search results are from Iraq.
- At least two selected features have `properties.routable_point`.
- Routing uses the selected `routable_point` values.
- Route request returns HTTP 200.
- Route response graph version starts with `valhalla-iraq-`.
- Geometry is non-empty and visible on the map.
- Distance and duration are visible to the user.
- Off-road snap behavior is honest.

## Current Status

Manual frontend QA remains pending until the live geocoder is available and the frontend is opened for visual verification.
