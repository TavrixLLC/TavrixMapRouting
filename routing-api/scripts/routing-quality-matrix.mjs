import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const matrixPath = process.env.ROUTING_QUALITY_MATRIX_PATH || resolve(repoRoot, 'config', 'routing-quality-matrix.json');
const matrix = JSON.parse(await readFile(resolvePath(matrixPath), 'utf8'));
const configBytes = await readFile(resolve(repoRoot, 'config', 'valhalla.json'));
const baseUrl = process.env.ROUTING_BASE_URL || 'http://localhost:8080';
const reportDir = resolve(repoRoot, 'reports');
const strict = String(process.env.ROUTING_MATRIX_STRICT || matrix.strict) === 'true';
const routeP95ThresholdMs = Number(matrix.thresholds?.route_p95_ms || 0);
const snapP95ThresholdMs = Number(matrix.thresholds?.snap_p95_ms || 0);
const results = [];

async function request(id, method, path, body) {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json().catch(() => null);
    return { id, status: response.status, ok: response.ok, latency_ms: Math.round(performance.now() - started), payload };
  } catch (error) {
    return { id, status: 0, ok: false, latency_ms: Math.round(performance.now() - started), error: error.message };
  }
}

const ready = await request('readiness', 'GET', '/health/ready');
results.push({ ...ready, passed: ready.ok && ready.payload?.ok === true });
const activeRegionMismatch = ready.payload?.active_build && matrix.region_id && !ready.payload.active_build.includes(matrix.region_id);
if (activeRegionMismatch) {
  results.push({
    id: 'active_graph_region',
    type: 'health',
    status: ready.status,
    ok: false,
    latency_ms: 0,
    payload: { active_build: ready.payload.active_build, expected_region: matrix.region_id },
    passed: false
  });
}

if (!activeRegionMismatch) {
  for (const route of matrix.routes) {
    const result = await request(route.id, 'POST', '/api/routing/route', { locations: route.locations, area: matrix.region_id, shape_format: 'geojson' });
    const distance = result.payload?.distance;
    const geometryPoints = result.payload?.geometry?.coordinates?.length || 0;
    results.push({
      ...result,
      type: 'route',
      distance,
      duration: result.payload?.duration,
      geometry_point_count: geometryPoints,
      passed: result.ok && geometryPoints > 1 && distance >= route.min_distance_km && distance <= route.max_distance_km
    });
  }

  for (const snap of matrix.snaps) {
    const result = await request(snap.id, 'POST', '/api/routing/snap', { locations: [snap.location], area: matrix.region_id, ...(snap.radius_meters ? { radius_meters: snap.radius_meters } : {}) });
    const item = result.payload?.results?.[0];
    results.push({
      ...result,
      type: 'snap',
      matched: item?.matched,
      edge_id: item?.edge_id ?? null,
      passed: result.ok && item?.matched === snap.expect_matched && (item?.matched ? item?.snapped != null : item?.snapped == null && item?.distance_meters == null)
    });
  }

  const matrixResult = await request('small_matrix', 'POST', '/api/routing/matrix', { locations: matrix.matrix.locations, area: matrix.region_id });
  results.push({ ...matrixResult, type: 'matrix', passed: matrixResult.ok && matrixResult.payload?.cells === 4 });

  const isochrone = await request('isochrone_sanity', 'POST', '/api/routing/isochrone', { ...matrix.isochrone, area: matrix.region_id });
  results.push({ ...isochrone, type: 'isochrone', passed: isochrone.ok && Array.isArray(isochrone.payload?.features) });
}

const latencies = results.filter((item) => item.type === 'route').map((item) => item.latency_ms).sort((a, b) => a - b);
const snapLatencies = results.filter((item) => item.type === 'snap').map((item) => item.latency_ms).sort((a, b) => a - b);
const routeP95 = percentile(latencies, 0.95);
const snapP95 = percentile(snapLatencies, 0.95);
if (!activeRegionMismatch && routeP95ThresholdMs > 0 && routeP95 != null && routeP95 > routeP95ThresholdMs) {
  results.push({
    id: 'route_p95_threshold',
    type: 'performance',
    status: 0,
    ok: false,
    latency_ms: routeP95,
    payload: { route_p95_ms: routeP95, threshold_ms: routeP95ThresholdMs },
    passed: false
  });
}
if (!activeRegionMismatch && snapP95ThresholdMs > 0 && snapP95 != null && snapP95 > snapP95ThresholdMs) {
  results.push({
    id: 'snap_p95_threshold',
    type: 'performance',
    status: 0,
    ok: false,
    latency_ms: snapP95,
    payload: { snap_p95_ms: snapP95, threshold_ms: snapP95ThresholdMs },
    passed: false
  });
}
const failures = results.filter((item) => !item.passed);
const report = {
  generated_at: new Date().toISOString(),
  region_id: matrix.region_id,
  base_url: baseUrl,
  graph_version: ready.payload?.active_build || null,
  active_service_name: ready.payload?.active_color ? `valhalla-${ready.payload.active_color}` : null,
  valhalla_config_sha256: createHash('sha256').update(configBytes).digest('hex'),
  thresholds: matrix.thresholds || {},
  route_p95_ms: routeP95,
  snap_p95_ms: snapP95,
  failed_cases: failures.map((item) => item.id),
  slowest_requests: [...results].sort((a, b) => b.latency_ms - a.latency_ms).slice(0, 10).map(({ id, latency_ms }) => ({ id, latency_ms })),
  results
};

await mkdir(reportDir, { recursive: true });
await writeFile(resolve(reportDir, 'routing-quality-matrix.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(reportDir, 'routing-quality-matrix.md'), markdown(report));
console.log(JSON.stringify({ graph_version: report.graph_version, route_p95_ms: report.route_p95_ms, snap_p95_ms: report.snap_p95_ms, failed_cases: report.failed_cases }, null, 2));
if (strict && failures.length) process.exit(1);

function percentile(values, quantile) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)];
}

function markdown(report) {
  const rows = report.results.map((item) => `| ${item.id} | ${item.type || 'health'} | ${item.status} | ${item.latency_ms} | ${item.passed ? 'PASS' : 'FAIL'} |`).join('\n');
  return `# Routing Quality Matrix\n\n- Generated: ${report.generated_at}\n- Region: ${report.region_id}\n- Graph version: ${report.graph_version || 'unresolved'}\n- Active service: ${report.active_service_name || 'unresolved'}\n- Valhalla config SHA-256: \`${report.valhalla_config_sha256}\`\n- Route p95: ${report.route_p95_ms ?? 'n/a'} ms (threshold ${report.thresholds.route_p95_ms ?? 'n/a'} ms)\n- Snap p95: ${report.snap_p95_ms ?? 'n/a'} ms (threshold ${report.thresholds.snap_p95_ms ?? 'n/a'} ms)\n\n| Case | Type | HTTP | Latency ms | Result |\n| --- | --- | ---: | ---: | --- |\n${rows}\n`;
}

function resolvePath(path) {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : resolve(repoRoot, path);
}
