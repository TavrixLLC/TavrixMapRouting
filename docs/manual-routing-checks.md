# Manual Routing Checks

Run these from PowerShell on the host while the routing runtime is up.

PowerShell/native `curl.exe` quoting differs between shells. The safest forms are `Invoke-RestMethod` with `ConvertTo-Json`, or a JSON body file with `curl.exe --data-binary`.

## Route

```powershell
$body = @{
  locations = @(
    @{ lat = 26.2235; lon = 50.5876 },
    @{ lat = 26.2285; lon = 50.5860 }
  )
  costing = "auto"
  area = "bahrain"
} | ConvertTo-Json -Depth 8 -Compress

Invoke-RestMethod -Method Post "http://localhost:8080/api/routing/route" `
  -ContentType "application/json" `
  -Body $body
```

Expected:

- HTTP 200.
- `geometry` is non-empty.
- `distance` is greater than 0.
- `duration` is greater than 0.
- `graph_version` is `valhalla-bahrain-20260602-1758` while the Bahrain graph is active.

## Snap Near Road

```powershell
$body = @{ lat = 26.2235; lon = 50.5876; radius_meters = 100; area = "bahrain" } |
  ConvertTo-Json -Depth 8 -Compress

Invoke-RestMethod -Method Post "http://localhost:8080/api/routing/snap" `
  -ContentType "application/json" `
  -Body $body
```

Expected:

- HTTP 200.
- `results[0].matched` is `true`.
- `results[0].snapped` is not `null`.

## Snap Offshore

```powershell
$body = @{ lat = 25.55; lon = 50.25; radius_meters = 100; area = "bahrain" } |
  ConvertTo-Json -Depth 8 -Compress

Invoke-RestMethod -Method Post "http://localhost:8080/api/routing/snap" `
  -ContentType "application/json" `
  -Body $body
```

Expected:

- HTTP 200.
- `results[0].matched` is `false`.
- `results[0].snapped` is `null`.
- `results[0].distance_meters` is `null`.

## Body File Fallback

If you prefer `curl.exe`, write the body to a file and send it with `--data-binary`.

```powershell
@'
{"locations":[{"lat":26.2235,"lon":50.5876},{"lat":26.2285,"lon":50.5860}],"costing":"auto","area":"bahrain"}
'@ | Set-Content -NoNewline -Encoding ascii .\route-body.json

curl.exe -s -X POST "http://localhost:8080/api/routing/route" `
  -H "Content-Type: application/json" `
  --data-binary "@route-body.json"
```
