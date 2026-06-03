import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const reportDir = resolve(repoRoot, 'reports');
const args = parseArgs(process.argv.slice(2));

const matrixPath = resolveRepoPath(option('matrix', 'ROUTING_QUALITY_MATRIX_PATH') || 'config/routing-quality-matrix.json');
const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
const regionPath = resolveRepoPath(option('region-config', 'ROUTING_REGION_PATH') || `config/regions/${matrix.region_id}.json`);
const region = JSON.parse(await readFile(regionPath, 'utf8'));
const routingBaseUrl = option('routing-base-url', 'ROUTING_BASE_URL') || 'http://localhost:8080';
const expectedCountry = normalizeCountry(option('expected-country', 'EXPECTED_COUNTRY') || firstCountryCode(region));
const allowCenterFallback = readBool(option('allow-center-fallback', 'ALLOW_CENTER_FALLBACK'), false);
const reportName = option('report-name', 'GEOCODER_FIXTURE_REPORT_NAME') || defaultReportName();
const report = {
  generated_at: new Date().toISOString(),
  matrix_path: relativePath(matrixPath),
  region_config_path: relativePath(regionPath),
  region_id: matrix.region_id,
  region_name: region.name || matrix.region_id,
  routing_base_url: routingBaseUrl,
  expected_country: expectedCountry || null,
  allow_center_fallback: allowCenterFallback,
  mode: null,
  passed: false,
  reason: null,
  active_graph: null,
  cases: []
};

class FixtureError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

try {
  const ready = await requestJson(`${routingBaseUrl}/health/ready`);
  report.active_graph = {
    ok: ready.ok && ready.payload?.ok === true,
    status: ready.status,
    active_color: ready.payload?.active_color || null,
    active_build: ready.payload?.active_build || null
  };
  if (!report.active_graph.ok) {
    throw new FixtureError('routing_not_ready', 'Routing readiness did not pass.');
  }
  if (report.active_graph.active_build && matrix.region_id && !report.active_graph.active_build.includes(matrix.region_id)) {
    throw new FixtureError('active_graph_region_mismatch', `Active graph ${report.active_graph.active_build} does not match matrix region ${matrix.region_id}.`);
  }

  const sources = await loadSources();
  if (!sources.length) {
    throw new FixtureError('not_configured', 'Set GEOCODER_FIXTURE_URL, GEOCODER_BASE_URL, GEOCODER_FIXTURE_FILE, or GEOCODER_FIXTURE_DIR.');
  }
  report.mode = sources[0].mode;
  for (const source of sources) {
    report.cases.push(await runSource(source));
  }
  const failed = report.cases.find((item) => !item.passed);
  if (failed) {
    throw new FixtureError(failed.reason, failed.error || `Fixture case ${failed.id} failed.`, { case_id: failed.id });
  }
  report.passed = true;
} catch (error) {
  report.reason = error instanceof FixtureError ? error.code : 'unexpected_error';
  report.error = error.message;
  if (error.details && Object.keys(error.details).length) report.details = error.details;
} finally {
  await mkdir(reportDir, { recursive: true });
  await writeReport(reportName, report);
  if (reportName !== 'geocoder-routing-fixture') {
    await writeReport('geocoder-routing-fixture', report);
  }
  console.log(JSON.stringify(report, null, 2));
}

if (!report.passed) process.exit(1);

async function loadSources() {
  const fixtureDir = option('fixture-dir', 'GEOCODER_FIXTURE_DIR');
  if (fixtureDir) {
    const directory = resolveRepoPath(fixtureDir);
    const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
    return Promise.all(files.map(async (file) => ({
      id: file.replace(/\.json$/, ''),
      mode: 'static_fixture',
      source: relativePath(resolve(directory, file)),
      payload: JSON.parse(await readFile(resolve(directory, file), 'utf8'))
    })));
  }

  const fixtureFile = option('fixture-file', 'GEOCODER_FIXTURE_FILE');
  if (fixtureFile) {
    const file = resolveRepoPath(fixtureFile);
    return [{
      id: basename(file).replace(/\.json$/, ''),
      mode: 'static_fixture',
      source: relativePath(file),
      payload: JSON.parse(await readFile(file, 'utf8'))
    }];
  }

  const fixtureUrl = option('fixture-url', 'GEOCODER_FIXTURE_URL');
  if (fixtureUrl) {
    const response = await requestJson(fixtureUrl, {}, 'geocoder_unavailable');
    return [{
      id: 'fixture_url',
      mode: 'fixture_url',
      source: fixtureUrl,
      response,
      payload: response.payload
    }];
  }

  const geocoderBaseUrl = option('geocoder-base-url', 'GEOCODER_BASE_URL');
  if (geocoderBaseUrl) {
    const url = liveGeocoderUrl(geocoderBaseUrl);
    const response = await requestJson(url, {}, 'geocoder_unavailable');
    return [{
      id: 'live_geocoder',
      mode: 'live_geocoder',
      source: url,
      response,
      payload: response.payload
    }];
  }

  return [];
}

async function runSource(source) {
  const started = performance.now();
  const result = {
    id: source.id,
    mode: source.mode,
    source: source.source,
    passed: false,
    reason: null,
    geocoder_status: source.response?.status || null,
    labels: [],
    countries: [],
    locations: [],
    routes: [],
    snaps: []
  };
  try {
    if (source.response && !source.response.ok) {
      throw new FixtureError('geocoder_http_error', `Geocoder returned HTTP ${source.response.status}.`);
    }
    const routingCase = source.payload?.metadata?.routing_case || source.payload?.routing_case || {};
    const features = extractFeatures(source.payload);
    if (!features.length) {
      throw new FixtureError('no_geocoder_features', 'Geocoder response did not contain features.');
    }
    const featurePoints = features.map((feature, index) => extractFeaturePoint(feature, index));
    result.labels = featurePoints.map((item) => item.label);
    result.countries = featurePoints.map((item) => item.country || null);
    result.locations = featurePoints.map((item) => ({ ...item.point, fallback_used: item.fallback_used }));

    if (routingCase.type === 'snap') {
      await runSnapCase(routingCase, featurePoints, result);
    } else {
      await runRouteCase(featurePoints, result);
    }

    result.passed = true;
  } catch (error) {
    result.reason = error instanceof FixtureError ? error.code : 'unexpected_error';
    result.error = error.message;
  } finally {
    result.latency_ms = Math.round(performance.now() - started);
  }
  return result;
}

function extractFeaturePoint(feature, index) {
  const properties = feature?.properties || feature || {};
  const label = properties.label || properties.name || `feature_${index}`;
  const country = normalizeCountry(properties.country_a || properties.country_code || properties.countryCode || properties.country);
  validateCountry(country, label);

  const routablePoint = normalizePoint(properties.routable_point || properties.routablePoint || firstArrayValue(properties.routable_points) || firstArrayValue(properties.routablePoints));
  const center = normalizePoint(feature?.geometry?.coordinates || properties.center || properties.coordinate);
  let point = routablePoint;
  let fallbackUsed = false;
  if (!point) {
    if (!allowCenterFallback) {
      throw new FixtureError('missing_routable_point', `Feature ${label} did not expose properties.routable_point and center fallback is disabled.`);
    }
    if (!center) {
      throw new FixtureError('missing_routable_point', `Feature ${label} did not expose a routable_point or geometry center.`);
    }
    point = center;
    fallbackUsed = true;
  }

  if (!pointInRegion(point)) {
    throw new FixtureError('point_outside_active_graph_region', `Feature ${label} point ${point.lat},${point.lon} is outside active region ${matrix.region_id}.`);
  }
  return { label, country, point, fallback_used: fallbackUsed };
}

async function runRouteCase(featurePoints, result) {
  const origin = matrix.routes?.[0]?.locations?.[0];
  if (!isCoordinate(origin)) {
    throw new FixtureError('missing_origin', 'routing-quality-matrix.json does not contain a valid route origin.');
  }
  const routeLocations = featurePoints.length >= 2 ? featurePoints.map((item) => item.point) : [origin, featurePoints[0].point];
  await routeAndRecord('forward', routeLocations, result);
  await routeAndRecord('reverse', [...routeLocations].reverse(), result);
}

async function routeAndRecord(direction, locations, result) {
  const response = await requestJson(`${routingBaseUrl}/api/routing/route`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ area: matrix.region_id, shape_format: 'geojson', locations })
  }, 'routing_unavailable');
  const geometryPoints = response.payload?.geometry?.coordinates?.length || 0;
  const routeResult = {
    direction,
    status: response.status,
    ok: response.ok,
    graph_version: response.payload?.graph_version || null,
    distance: response.payload?.distance ?? null,
    duration: response.payload?.duration ?? null,
    geometry_point_count: geometryPoints
  };
  result.routes.push(routeResult);
  if (!response.ok) {
    throw new FixtureError('route_failed', `Routing returned HTTP ${response.status} for ${direction} case.`);
  }
  if (!routeResult.graph_version) {
    throw new FixtureError('missing_graph_version', `Routing response for ${direction} case did not include graph_version.`);
  }
  if (geometryPoints < 2) {
    throw new FixtureError('route_geometry_empty', `Routing response for ${direction} case had empty geometry.`);
  }
}

async function runSnapCase(routingCase, featurePoints, result) {
  const response = await requestJson(`${routingBaseUrl}/api/routing/snap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ area: matrix.region_id, locations: [featurePoints[0].point] })
  }, 'routing_unavailable');
  const item = response.payload?.results?.[0];
  const snapResult = {
    status: response.status,
    ok: response.ok,
    graph_version: response.payload?.graph_version || null,
    matched: item?.matched ?? null,
    reason: item?.reason || null
  };
  result.snaps.push(snapResult);
  if (!response.ok) {
    throw new FixtureError('snap_failed', `Snap returned HTTP ${response.status}.`);
  }
  if (!snapResult.graph_version) {
    throw new FixtureError('missing_graph_version', 'Snap response did not include graph_version.');
  }
  if (typeof routingCase.expect_matched === 'boolean' && item?.matched !== routingCase.expect_matched) {
    throw new FixtureError('snap_expectation_failed', `Snap matched=${item?.matched}; expected ${routingCase.expect_matched}.`);
  }
}

function extractFeatures(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.features)) return payload.features;
  if (Array.isArray(payload.results)) return payload.results;
  if (payload.type === 'Feature') return [payload];
  if (payload.feature) return extractFeatures(payload.feature);
  if (payload.result) return extractFeatures(payload.result);
  return [];
}

function validateCountry(country, label) {
  if (expectedCountry && !country) {
    throw new FixtureError('geocoder_region_mismatch', `Feature ${label} has no country code; expected ${expectedCountry}.`);
  }
  if (expectedCountry && country && !countryMatches(country, expectedCountry)) {
    throw new FixtureError('geocoder_region_mismatch', `Feature ${label} country ${country} does not match expected ${expectedCountry}.`);
  }
  const regionCountries = (region.country_codes || []).map(normalizeCountry).filter(Boolean);
  if (country && regionCountries.length && !regionCountries.some((item) => countryMatches(country, item))) {
    throw new FixtureError('geocoder_region_mismatch', `Feature ${label} country ${country} does not match active graph region ${matrix.region_id}.`);
  }
}

async function requestJson(url, options = {}, unavailableCode = 'request_unavailable') {
  const started = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(Number(option('timeout-ms', 'GEOCODER_FIXTURE_TIMEOUT_MS') || 15000)) });
    const payload = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, latency_ms: Math.round(performance.now() - started), payload };
  } catch (error) {
    throw new FixtureError(unavailableCode, `${url} is unavailable: ${error.message}`);
  }
}

function liveGeocoderUrl(baseUrl) {
  const path = option('fixture-path', 'GEOCODER_FIXTURE_PATH');
  const base = baseUrl.replace(/\/+$/, '');
  if (path) return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const url = new URL(base.endsWith('/v1/search') ? base : `${base}/v1/search`);
  url.searchParams.set('text', option('query-text', 'GEOCODER_QUERY_TEXT') || 'Manama, Bahrain');
  url.searchParams.set('size', option('size', 'GEOCODER_QUERY_SIZE') || '3');
  const focusLat = option('focus-lat', 'GEOCODER_FOCUS_LAT');
  const focusLon = option('focus-lon', 'GEOCODER_FOCUS_LON');
  if (focusLat && focusLon) {
    url.searchParams.set('focus.point.lat', focusLat);
    url.searchParams.set('focus.point.lon', focusLon);
  }
  return url.toString();
}

function normalizePoint(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 2) return { lon: Number(value[0]), lat: Number(value[1]) };
  if (typeof value === 'object') {
    if ('lat' in value && 'lon' in value) return { lat: Number(value.lat), lon: Number(value.lon) };
    if ('latitude' in value && 'longitude' in value) return { lat: Number(value.latitude), lon: Number(value.longitude) };
    if ('lat' in value && 'lng' in value) return { lat: Number(value.lat), lon: Number(value.lng) };
  }
  return null;
}

function isCoordinate(value) {
  return Number.isFinite(value?.lat) && Number.isFinite(value?.lon) && Math.abs(value.lat) <= 90 && Math.abs(value.lon) <= 180;
}

function pointInRegion(point) {
  const [minLon, minLat, maxLon, maxLat] = region.bbox || [];
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return true;
  return point.lon >= minLon && point.lon <= maxLon && point.lat >= minLat && point.lat <= maxLat;
}

function normalizeCountry(value) {
  if (!value) return null;
  const raw = String(value).trim().toUpperCase();
  const aliases = new Map([
    ['BAHRAIN', 'BH'],
    ['BHR', 'BH'],
    ['BH', 'BH'],
    ['IRAQ', 'IQ'],
    ['IRQ', 'IQ'],
    ['IQ', 'IQ']
  ]);
  return aliases.get(raw) || raw;
}

function countryMatches(left, right) {
  return normalizeCountry(left) === normalizeCountry(right);
}

function firstCountryCode(config) {
  return Array.isArray(config.country_codes) ? config.country_codes[0] : '';
}

function firstArrayValue(value) {
  return Array.isArray(value) ? value[0] : null;
}

function readBool(value, defaultValue) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function option(argName, envName) {
  return args[argName] ?? process.env[envName] ?? '';
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawName, inlineValue] = token.slice(2).split('=', 2);
    parsed[rawName] = inlineValue ?? argv[index + 1] ?? 'true';
    if (inlineValue == null && argv[index + 1] && !argv[index + 1].startsWith('--')) index += 1;
  }
  return parsed;
}

function resolveRepoPath(path) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

function relativePath(path) {
  return path.replace(`${repoRoot}\\`, '').replace(`${repoRoot}/`, '').replace(/\\/g, '/');
}

function defaultReportName() {
  if (option('fixture-dir', 'GEOCODER_FIXTURE_DIR') || option('fixture-file', 'GEOCODER_FIXTURE_FILE')) return 'geocoder-routing-fixture-static';
  if (option('geocoder-base-url', 'GEOCODER_BASE_URL')) return 'geocoder-routing-fixture-live';
  return 'geocoder-routing-fixture';
}

async function writeReport(name, result) {
  await writeFile(resolve(reportDir, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(resolve(reportDir, `${name}.md`), markdown(result));
}

function markdown(result) {
  const rows = result.cases.map((item) => `| ${item.id} | ${item.mode} | ${item.passed ? 'PASS' : 'FAIL'} | ${item.reason || 'none'} | ${item.routes.length} | ${item.snaps.length} |`).join('\n');
  return `# Geocoder To Routing Fixture

- Generated: ${result.generated_at}
- Result: ${result.passed ? 'PASS' : 'FAIL'}
- Reason: ${result.reason || 'none'}
- Mode: ${result.mode || 'unresolved'}
- Region: ${result.region_id}
- Expected country: ${result.expected_country || 'not configured'}
- Routing base URL: ${result.routing_base_url}
- Active graph: ${result.active_graph?.active_build || 'unresolved'}
- Allow center fallback: ${result.allow_center_fallback}

| Case | Mode | Result | Reason | Routes | Snaps |
| --- | --- | --- | --- | ---: | ---: |
${rows || '| none | none | FAIL | not_configured | 0 | 0 |'}
`;
}
