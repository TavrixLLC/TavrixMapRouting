import express from 'express';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants, readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { buildOpenApiSpec } from './openapi.js';

const app = express();
app.set('trust proxy', 1);

const PORT = Number(process.env.ROUTING_API_PORT || 3000);
const BLUE_URL = process.env.VALHALLA_BLUE_URL || process.env.VALHALLA_REGIONAL_URL || process.env.VALHALLA_INTERNAL_URL || 'http://valhalla-blue:8002';
const GREEN_URL = process.env.VALHALLA_GREEN_URL || 'http://valhalla-green:8002';
const WORLD_URL = process.env.VALHALLA_WORLD_URL || '';
const TIMEOUT_MS = Number(process.env.VALHALLA_TIMEOUT_MS || 10000);
const VALHALLA_DNS_ROUND_ROBIN = String(process.env.VALHALLA_DNS_ROUND_ROBIN || 'true') === 'true';
const VALHALLA_DNS_TTL_MS = Number(process.env.VALHALLA_DNS_TTL_MS || 30000);
const ROUTING_ACCESS_LOG = String(process.env.ROUTING_ACCESS_LOG || 'false') === 'true';
const REGION = process.env.VALHALLA_REGION || 'bahrain';
const ACTIVE_ROOT = process.env.VALHALLA_ACTIVE_ROOT || '/valhalla/active';
const ACTIVE_VERSION_PATH = process.env.VALHALLA_ACTIVE_VERSION_PATH || join(ACTIVE_ROOT, 'active_version.json');
const VALHALLA_CONFIG_PATH = process.env.VALHALLA_CONFIG_PATH || '/valhalla/config/valhalla.json';
const WORLD_METADATA_PATH = process.env.VALHALLA_WORLD_METADATA_PATH || '';
const BUILDS_PATH = process.env.VALHALLA_BUILDS_PATH || '/valhalla/builds';
const INTERNAL_TOKEN = process.env.ROUTING_INTERNAL_TOKEN || '';
const BUILD_ENDPOINTS_ENABLED = String(process.env.ROUTING_BUILD_ENDPOINTS_ENABLED || 'true') === 'true';
const LIMITS_PATH = process.env.ROUTING_LIMITS_PATH || '../config/routing-limits.json';
const REGION_PATH = process.env.ROUTING_REGION_PATH || `../config/regions/${REGION}.json`;
const LIMITS = loadJsonFileSync(LIMITS_PATH, {});
const REGION_CONFIG = loadJsonFileSync(REGION_PATH, {});
const MAX_ROUTE_LOCATIONS = configuredLimit('MAX_ROUTE_LOCATIONS', 'max_route_locations', 20);
const MAX_MATRIX_SOURCES = configuredLimit('MAX_MATRIX_SOURCES', 'max_matrix_sources', 25);
const MAX_MATRIX_TARGETS = configuredLimit('MAX_MATRIX_TARGETS', 'max_matrix_targets', 25);
const MAX_MATRIX_CELLS = configuredLimit('MAX_MATRIX_CELLS', 'max_matrix_cells', 625);
const MAX_SNAP_LOCATIONS = configuredLimit('MAX_SNAP_LOCATIONS', 'max_snap_locations', 100);
const DEFAULT_SNAP_RADIUS_METERS = configuredLimit('DEFAULT_SNAP_RADIUS_METERS', 'default_snap_radius_meters', 50);
const MAX_SNAP_RADIUS_METERS = configuredLimit('MAX_SNAP_RADIUS_METERS', 'max_snap_radius_meters', 200);
const MAX_MAP_MATCH_POINTS = configuredLimit('MAX_MAP_MATCH_POINTS', 'max_map_match_points', 500);
const MAX_OPTIMIZATION_JOBS = configuredLimit('MAX_OPTIMIZATION_JOBS', 'max_optimization_jobs', 18);
const MAX_ISOCHRONE_LOCATIONS = configuredLimit('MAX_ISOCHRONE_LOCATIONS', 'max_isochrone_locations', 1);
const MAX_ISOCHRONE_CONTOURS = configuredLimit('MAX_ISOCHRONE_CONTOURS', 'max_isochrone_contours', 4);
const MAX_ALTERNATIVES = configuredLimit('MAX_ALTERNATIVES', 'max_alternatives', 2);
const REGIONAL_BOUNDS = parseBounds(process.env.VALHALLA_REGIONAL_BOUNDS || '50.2,25.5,51.0,26.6');
const IMPORTANT_AREAS = parseImportantAreas(process.env.VALHALLA_IMPORTANT_AREAS, REGION, REGIONAL_BOUNDS);
const PROBE_LOCATE = REGION_CONFIG.probe?.locate || { lat: 26.2235, lon: 50.5876 };
const PROBE_ROUTE = REGION_CONFIG.probe?.route || [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }];

let activeVersion = loadActiveVersion();
const upstreamDnsCache = new Map();
const upstreamRoundRobin = new Map();
const upstreamInflight = new Map();
startActiveVersionWatcher();
validateLimitsAgainstValhalla();

const COSTING = new Set(['auto', 'pedestrian', 'bicycle', 'motor_scooter', 'motorcycle', 'truck', 'bus', 'taxi']);
const UNITS = new Set(['kilometers', 'miles']);
const ENGINES = new Set(['auto', 'regional', 'world']);
const SHAPE_FORMATS = new Set(['polyline6', 'polyline', 'geojson']);
const OVERVIEWS = new Set(['full', 'simplified', 'false']);
const ANNOTATIONS = new Set(['duration', 'distance', 'speed', 'nodes', 'road_class', 'maxspeed']);

app.use(requestIdMiddleware);
app.use(metricsMiddleware);
app.use(express.json({ limit: '512kb' }));
app.use(jsonBodyErrorMiddleware);
app.use(rateLimitMiddleware);

const OPENAPI_SPEC = buildOpenApiSpec({
  port: PORT,
  regionalUrl: regionalUrl(),
  worldUrl: WORLD_URL,
  region: REGION,
  importantAreas: IMPORTANT_AREAS
});

function apiError(status, code, message, details) {
  return { error: { status, code, message, ...(details ? { details } : {}) } };
}

function sendError(res, status, code, message, details) {
  return res.status(status).json(withRequestId(res, apiError(status, code, message, details)));
}

function jsonBodyErrorMiddleware(err, _req, res, next) {
  if (err?.type === 'entity.parse.failed') return sendError(res, 400, 'invalid_json', 'Request body must be valid JSON');
  if (err?.type === 'entity.too.large') return sendError(res, 413, 'payload_too_large', 'Request body exceeds the 512kb limit');
  return next(err);
}

function withRequestId(res, payload) {
  const requestId = res.locals?.requestId;
  if (requestId && payload?.error) payload.error.request_id = requestId;
  else if (requestId && payload && typeof payload === 'object' && !Array.isArray(payload)) payload.request_id = requestId;
  return payload;
}

function requestIdMiddleware(req, res, next) {
  const requestId = String(req.header('x-request-id') || randomUUID());
  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}

function endpointLabel(req) {
  return req.route?.path
    ? `${req.method} ${Array.isArray(req.route.path) ? req.route.path[0] : req.route.path}`
    : `${req.method} unmatched`;
}

const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const metrics = {
  requestTotal: new Map(),
  requestDuration: new Map(),
  requestHistogram: new Map(),
  upstreamDuration: new Map(),
  upstreamHistogram: new Map(),
  upstreamErrors: new Map(),
  snapResults: new Map(),
  matrixCells: 0,
  optimizationJobs: 0,
  ready: 0,
  routeProbeOk: 0,
  locateProbeOk: 0
};

function inc(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

function observe(map, key, value) {
  const current = map.get(key) || { count: 0, sum: 0 };
  current.count += 1;
  current.sum += value;
  map.set(key, current);
}

function observeHistogram(map, key, value) {
  const current = map.get(key) || { count: 0, sum: 0, buckets: HISTOGRAM_BUCKETS.map(() => 0) };
  current.count += 1;
  current.sum += value;
  HISTOGRAM_BUCKETS.forEach((bucket, index) => {
    if (value <= bucket) current.buckets[index] += 1;
  });
  map.set(key, current);
}

function metricsMiddleware(req, res, next) {
  const started = process.hrtime.bigint();
  const end = res.end;
  res.end = function (...args) {
    if (!res.headersSent) {
      const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;
      res.setHeader('x-response-time-ms', milliseconds.toFixed(1));
    }
    return end.apply(this, args);
  };
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    const endpoint = endpointLabel(req);
    inc(metrics.requestTotal, `${endpoint}|${res.statusCode}`);
    observe(metrics.requestDuration, endpoint, seconds);
    observeHistogram(metrics.requestHistogram, endpoint, seconds);
    if (ROUTING_ACCESS_LOG || res.statusCode >= 400) {
      console.log(JSON.stringify({ request_id: req.requestId, method: req.method, path: req.path, status: res.statusCode, duration_ms: Math.round(seconds * 1000) }));
    }
  });
  next();
}

function renderMetrics() {
  const lines = [
    '# TYPE routing_request_total counter',
    ...Array.from(metrics.requestTotal.entries()).map(([key, value]) => {
      const [endpoint, status] = key.split('|');
      return `routing_request_total{endpoint=${JSON.stringify(endpoint)},status=${JSON.stringify(status)}} ${value}`;
    }),
    '# TYPE routing_request_duration_seconds histogram',
    ...histogramLines('routing_request_duration_seconds', metrics.requestHistogram, ['endpoint']),
    '# TYPE routing_upstream_duration_seconds histogram',
    ...histogramLines('routing_upstream_duration_seconds', metrics.upstreamHistogram, ['endpoint', 'engine']),
    '# TYPE routing_upstream_errors_total counter',
    ...Array.from(metrics.upstreamErrors.entries()).map(([key, value]) => {
      const [engine, code] = key.split('|');
      return `routing_upstream_errors_total{engine=${JSON.stringify(engine)},code=${JSON.stringify(code)}} ${value}`;
    }),
    '# TYPE routing_matrix_cells_total counter',
    `routing_matrix_cells_total ${metrics.matrixCells}`,
    '# TYPE routing_optimization_jobs_total counter',
    `routing_optimization_jobs_total ${metrics.optimizationJobs}`,
    '# TYPE routing_snap_results_total counter',
    `routing_snap_results_total{matched="true"} ${metrics.snapResults.get('true') || 0}`,
    `routing_snap_results_total{matched="false"} ${metrics.snapResults.get('false') || 0}`,
    '# TYPE routing_ready gauge',
    `routing_ready ${metrics.ready}`,
    '# TYPE routing_route_probe_ok gauge',
    `routing_route_probe_ok ${metrics.routeProbeOk}`,
    '# TYPE routing_locate_probe_ok gauge',
    `routing_locate_probe_ok ${metrics.locateProbeOk}`,
    '# TYPE routing_active_graph_info gauge',
    `routing_active_graph_info{version=${JSON.stringify(graphVersion() || 'unknown')},color=${JSON.stringify(activeVersion.active)}} 1`,
    '# TYPE routing_active_graph_created_timestamp_seconds gauge',
    `routing_active_graph_created_timestamp_seconds ${activeVersion.created_at ? Math.floor(new Date(activeVersion.created_at).getTime() / 1000) : 0}`
  ];
  return `${lines.join('\n')}\n`;
}

function summaryLines(metricName, map, labelNames) {
  return Array.from(map.entries()).flatMap(([key, value]) => {
    const parts = key.split('|');
    const labels = labelNames.map((name, index) => `${name}=${JSON.stringify(parts[index] || '')}`).join(',');
    return [
      `${metricName}_count{${labels}} ${value.count}`,
      `${metricName}_sum{${labels}} ${value.sum}`
    ];
  });
}

function readPositiveInt(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const rateLimitWindows = new Map();

function rateLimitMiddleware(req, res, next) {
  if (process.env.NODE_ENV === 'test') return next();
  const path = req.path;
  const expensive = /^\/api\/routing\/(matrix|isochrone|map-match|optimization)$/.test(path);
  const standard = /^\/api\/routing\/(route|distance|snap|nearest)$/.test(path) || path.startsWith('/api/routing/directions/');
  if (!expensive && !standard) return next();
  const limit = expensive ? Number(process.env.ROUTING_EXPENSIVE_RATE_LIMIT || 10) : Number(process.env.ROUTING_STANDARD_RATE_LIMIT || 250);
  const now = Date.now();
  const key = `${req.ip}|${expensive ? 'expensive' : 'standard'}`;
  const current = rateLimitWindows.get(key);
  const windowState = !current || now >= current.resetAt ? { count: 0, resetAt: now + 1000 } : current;
  windowState.count += 1;
  rateLimitWindows.set(key, windowState);
  res.setHeader('x-ratelimit-limit', String(limit));
  res.setHeader('x-ratelimit-remaining', String(Math.max(0, limit - windowState.count)));
  if (windowState.count > limit) return sendError(res, 429, 'rate_limited', 'Too many routing requests');
  if (rateLimitWindows.size > 10000) {
    for (const [entryKey, value] of rateLimitWindows) if (now >= value.resetAt) rateLimitWindows.delete(entryKey);
  }
  return next();
}

function histogramLines(metricName, map, labelNames) {
  return Array.from(map.entries()).flatMap(([key, value]) => {
    const parts = key.split('|');
    const baseLabels = labelNames.map((name, index) => `${name}=${JSON.stringify(parts[index] || '')}`);
    return [
      ...HISTOGRAM_BUCKETS.map((bucket, index) => `${metricName}_bucket{${[...baseLabels, `le=${JSON.stringify(String(bucket))}`].join(',')}} ${value.buckets[index]}`),
      `${metricName}_bucket{${[...baseLabels, 'le="+Inf"'].join(',')}} ${value.count}`,
      `${metricName}_count{${baseLabels.join(',')}} ${value.count}`,
      `${metricName}_sum{${baseLabels.join(',')}} ${value.sum}`
    ];
  });
}

function loadJsonFileSync(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function isSafeBuildId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function configuredLimit(envName, configName, fallback) {
  const configured = readPositiveInt(configName, LIMITS[configName] ?? fallback);
  const overridden = process.env[envName];
  if (overridden == null || overridden === '') return configured;
  const value = readPositiveInt(envName, overridden);
  if (value > configured) throw new Error(`${envName}=${value} exceeds configured safety limit ${configured}`);
  return value;
}

function validateLimitsAgainstValhalla() {
  const config = loadJsonFileSync(VALHALLA_CONFIG_PATH);
  if (!config) return;
  const serviceLimits = config.service_limits || {};
  const auto = serviceLimits.auto || {};
  const isochrone = serviceLimits.isochrone || {};
  const conflicts = [];
  if (MAX_ROUTE_LOCATIONS > Number(auto.max_locations || 0)) conflicts.push(`route locations ${MAX_ROUTE_LOCATIONS} > Valhalla auto.max_locations ${auto.max_locations}`);
  if (MAX_SNAP_RADIUS_METERS > Number(serviceLimits.max_radius || 0)) conflicts.push(`snap radius ${MAX_SNAP_RADIUS_METERS} > Valhalla max_radius ${serviceLimits.max_radius}`);
  if (MAX_ISOCHRONE_LOCATIONS > Number(isochrone.max_locations || 0)) conflicts.push(`isochrone locations ${MAX_ISOCHRONE_LOCATIONS} > Valhalla isochrone.max_locations ${isochrone.max_locations}`);
  if (MAX_ALTERNATIVES > Number(serviceLimits.max_alternates || 0)) conflicts.push(`alternatives ${MAX_ALTERNATIVES} > Valhalla max_alternates ${serviceLimits.max_alternates}`);
  if (MAX_MATRIX_CELLS > Number(auto.max_matrix_location_pairs || 0)) conflicts.push(`matrix cells ${MAX_MATRIX_CELLS} > Valhalla auto.max_matrix_location_pairs ${auto.max_matrix_location_pairs}`);
  if (conflicts.length) throw new Error(`Routing limit configuration conflicts with Valhalla: ${conflicts.join('; ')}`);
}

function loadActiveVersion() {
  const version = loadJsonFileSync(ACTIVE_VERSION_PATH, {});
  const active = version.active === 'green' ? 'green' : 'blue';
  return {
    active,
    previous: version.previous === 'green' ? 'green' : 'blue',
    build_id: version.build_id || null,
    created_at: version.created_at || null,
    config_sha256: version.config_sha256 || null
  };
}

function startActiveVersionWatcher() {
  if (process.env.NODE_ENV === 'test') return;
  try {
    watch(dirname(ACTIVE_VERSION_PATH), (_event, filename) => {
      if (!filename || String(filename) === ACTIVE_VERSION_PATH.split(/[\\/]/).pop()) {
        activeVersion = loadActiveVersion();
      }
    });
  } catch {
    // Readiness reports a missing active version file; startup remains useful for diagnostics.
  }
}

function regionalUrl() {
  return activeVersion.active === 'green' ? GREEN_URL : BLUE_URL;
}

function activeGraphPath() {
  return join(ACTIVE_ROOT, activeVersion.active);
}

function graphVersion() {
  return activeVersion.build_id;
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function asBool(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (String(value).toLowerCase() === 'true') return true;
  if (String(value).toLowerCase() === 'false') return false;
  return null;
}

function parseBounds(value) {
  const parts = String(value || '').split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon >= maxLon || minLat >= maxLat) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function parseImportantAreas(value, defaultRegion, defaultBounds) {
  const areas = [];
  for (const item of String(value || '').split(';')) {
    const [idPart, labelPart, boundsPart] = item.trim().split('|');
    const id = String(idPart || '').trim().toLowerCase();
    const label = String(labelPart || id).trim();
    const bounds = parseBounds(boundsPart);
    if (id && bounds) areas.push({ id, label, bounds });
  }
  if (!areas.length && defaultBounds) areas.push({ id: defaultRegion, label: defaultRegion, bounds: defaultBounds });
  return areas;
}

function insideBounds(point, bounds) {
  return Boolean(bounds)
    && point.lon >= bounds.minLon
    && point.lon <= bounds.maxLon
    && point.lat >= bounds.minLat
    && point.lat <= bounds.maxLat;
}

function findArea(areaId) {
  if (!areaId) return null;
  return IMPORTANT_AREAS.find((area) => area.id === String(areaId).toLowerCase()) || null;
}

function findContainingArea(locations) {
  return IMPORTANT_AREAS.find((area) => locations.every((point) => insideBounds(point, area.bounds))) || null;
}

function validateLocations(locations, { min, max, name = 'locations' }) {
  if (!Array.isArray(locations)) return `${name} must be an array`;
  if (locations.length < min) return `${name} requires at least ${min} point(s)`;
  if (locations.length > max) return `${name} allows at most ${max} point(s)`;
  for (const [index, point] of locations.entries()) {
    if (!point || !isNumber(point.lat) || !isNumber(point.lon)) return `${name}[${index}] must include numeric lat and lon`;
    if (point.lat < -90 || point.lat > 90) return `${name}[${index}].lat must be between -90 and 90`;
    if (point.lon < -180 || point.lon > 180) return `${name}[${index}].lon must be between -180 and 180`;
  }
  return null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function validationCode(message) {
  return String(message || '').match(/(\.lat|\.lon|numeric lat and lon|coordinate)/) ? 'invalid_coordinate' : 'invalid_request';
}

function sendValidationError(res, message) {
  return sendError(res, 400, validationCode(message), message);
}

function validateEnum(value, set, name) {
  return set.has(value) ? null : `${name} must be one of: ${Array.from(set).join(', ')}`;
}

function validateArea(areaId) {
  if (!areaId || findArea(areaId)) return null;
  return `area must be one of: ${IMPORTANT_AREAS.map((area) => area.id).join(', ')}`;
}

function validateIsoDatetime(value, name) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? `${name} must be a valid ISO datetime` : null;
}

function validateTruck(truck) {
  if (!truck) return null;
  for (const field of ['height', 'width', 'length', 'weight']) {
    if (truck[field] != null && (!isNumber(truck[field]) || truck[field] <= 0)) return `truck.${field} must be a positive number`;
  }
  if (truck.hazmat != null && typeof truck.hazmat !== 'boolean') return 'truck.hazmat must be a boolean';
  return null;
}

function parseCoordinatesParam(value) {
  const parts = String(value || '').split(';').filter(Boolean);
  if (!parts.length) return [{ lat: Number.NaN, lon: Number.NaN }, { lat: Number.NaN, lon: Number.NaN }];
  let malformed = false;
  const locations = parts.map((pair) => {
    const pieces = pair.split(',');
    if (pieces.length !== 2) {
      malformed = true;
      return { lat: Number.NaN, lon: Number.NaN };
    }
    const [lon, lat] = pieces.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) malformed = true;
    return { lat, lon };
  });
  if (malformed && locations.length < 2) locations.push({ lat: Number.NaN, lon: Number.NaN });
  return locations;
}

function parseAnnotations(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function collectRouteOptions(source) {
  const warnings = [];
  const booleans = ['alternatives', 'steps', 'avoid_tolls', 'avoid_highways', 'avoid_ferries', 'avoid_unpaved', 'voice_instructions', 'banner_instructions'];
  const options = {
    units: source.units || 'kilometers',
    engine: source.engine || 'auto',
    area: source.area || null,
    max_alternatives: source.max_alternatives == null ? 1 : Number(source.max_alternatives),
    language: source.language || 'en',
    shape_format: source.shape_format || 'polyline6',
    overview: source.overview || 'full',
    annotations: parseAnnotations(source.annotations),
    depart_at: source.depart_at || null,
    arrive_by: source.arrive_by || null,
    truck: source.truck || null,
    include_raw: asBool(source.include_raw, false)
  };
  for (const field of booleans) options[field] = asBool(source[field], false);

  const validationError = validateEnum(options.units, UNITS, 'units')
    || validateEnum(options.engine, ENGINES, 'engine')
    || validateArea(options.area)
    || validateEnum(options.shape_format, SHAPE_FORMATS, 'shape_format')
    || validateEnum(options.overview, OVERVIEWS, 'overview')
    || validateIsoDatetime(options.depart_at, 'depart_at')
    || validateIsoDatetime(options.arrive_by, 'arrive_by')
    || validateTruck(options.truck);
  if (validationError) return { validationError };
  if (options.depart_at && options.arrive_by) return { validationError: 'depart_at and arrive_by cannot both be set' };
  if (!Number.isInteger(options.max_alternatives) || options.max_alternatives < 1 || options.max_alternatives > MAX_ALTERNATIVES) return { validationError: `max_alternatives must be between 1 and ${MAX_ALTERNATIVES}` };
  for (const field of booleans) if (options[field] === null) return { validationError: `${field} must be true or false` };
  if (options.include_raw === null) return { validationError: 'include_raw must be true or false' };
  for (const annotation of options.annotations) {
    if (!ANNOTATIONS.has(annotation)) return { validationError: `annotations contains unsupported value: ${annotation}` };
  }
  if (options.overview === 'simplified') return { validationError: 'overview=simplified is not supported; use full or false' };
  if (options.annotations.length) return { validationError: 'annotations are not supported by this Valhalla proxy' };
  if (options.depart_at || options.arrive_by) warnings.push('Time-dependent routing is passed to Valhalla when supported; live traffic is not configured in this deployment.');
  if (options.voice_instructions || options.banner_instructions) warnings.push('Voice/banner instructions are represented by maneuver instructions when Valhalla narrative is available.');
  return { options, warnings };
}

function shouldIncludeRaw(options = {}) {
  const includeRaw = String(process.env.ROUTING_INCLUDE_RAW || process.env.VALHALLA_INCLUDE_RAW || 'false') === 'true';
  const allowRequestRaw = String(process.env.ROUTING_ALLOW_REQUEST_RAW || 'false') === 'true';
  return includeRaw || (allowRequestRaw && options.include_raw === true);
}

function selectRoutingEngine(locations, requestedEngine = 'auto', requestedArea = null) {
  const selectedArea = findArea(requestedArea);
  const matchingArea = findContainingArea(locations);
  if (requestedEngine === 'regional') {
    if (selectedArea && !locations.every((point) => insideBounds(point, selectedArea.bounds))) {
      return { name: 'regional', url: null, area: selectedArea.id, error: `Route points are outside selected area: ${selectedArea.id}` };
    }
    if (!selectedArea && !matchingArea) {
      return { name: 'regional', url: null, area: REGION, error: 'Route points are outside regional graph coverage' };
    }
    return { name: 'regional', url: regionalUrl(), area: selectedArea?.id || matchingArea?.id || REGION };
  }
  if (requestedEngine === 'world') return WORLD_URL ? { name: 'world', url: WORLD_URL } : { name: 'world', url: null, error: 'World Valhalla is not configured' };
  if (selectedArea) {
    if (locations.every((point) => insideBounds(point, selectedArea.bounds))) return { name: 'regional', url: regionalUrl(), area: selectedArea.id };
    return { name: 'world', url: WORLD_URL || null, area: selectedArea.id, error: WORLD_URL ? null : `World Valhalla is not configured and route is outside selected area: ${selectedArea.id}` };
  }
  if (matchingArea) return { name: 'regional', url: regionalUrl(), area: matchingArea.id };
  if (WORLD_URL) return { name: 'world', url: WORLD_URL };
  return { name: 'world', url: null, error: 'World Valhalla is not configured for routes outside the regional bounds' };
}

function buildValhallaRouteBody(locations, costing, options) {
  const costingOptions = {};
  if (options.avoid_tolls) costingOptions.use_tolls = 0;
  if (options.avoid_highways) costingOptions.use_highways = 0;
  if (options.avoid_ferries) costingOptions.use_ferry = 0;
  if (options.avoid_unpaved) costingOptions.use_tracks = 0;
  if (options.truck) {
    costingOptions.truck = {
      ...(options.truck.height ? { height: options.truck.height } : {}),
      ...(options.truck.width ? { width: options.truck.width } : {}),
      ...(options.truck.length ? { length: options.truck.length } : {}),
      ...(options.truck.weight ? { weight: options.truck.weight } : {}),
      ...(options.truck.hazmat != null ? { hazmat: options.truck.hazmat } : {})
    };
  }
  return {
    locations,
    costing,
    directions_options: {
      units: options.units,
      language: options.language,
      narrative: options.steps !== false
    },
    ...(options.alternatives ? { alternates: options.max_alternatives } : {}),
    ...(options.depart_at ? { date_time: { type: 1, value: options.depart_at } } : {}),
    ...(options.arrive_by ? { date_time: { type: 2, value: options.arrive_by } } : {}),
    ...(Object.keys(costingOptions).length ? { costing_options: { [costing]: costingOptions, ...(costingOptions.truck ? { truck: costingOptions.truck } : {}) } } : {})
  };
}

async function callValhalla(path, body, engine) {
  if (!engine.url) return { ok: false, status: 503, body: apiError(503, 'engine_unavailable', engine.error || 'Selected Valhalla engine is not configured') };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = process.hrtime.bigint();
  let upstream = { url: trimTrailingSlash(engine.url), release: () => {} };
  try {
    upstream = await selectUpstream(engine.url);
    const response = await fetch(`${upstream.url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok || payload.error || payload.status_code >= 400) {
      const status = response.status >= 400 ? response.status : 502;
      inc(metrics.upstreamErrors, `${engine.name}|${status}`);
      return { ok: false, status, body: apiError(status, 'valhalla_error', 'Valhalla request failed', payload) };
    }
    return { ok: true, status: 200, body: payload, engine };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    const status = timedOut ? 504 : 502;
    inc(metrics.upstreamErrors, `${engine.name}|${status}`);
    return { ok: false, status, body: apiError(status, timedOut ? 'upstream_timeout' : 'upstream_unavailable', timedOut ? 'Valhalla request timed out' : 'Valhalla is unavailable') };
  } finally {
    upstream.release();
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    observe(metrics.upstreamDuration, `${path}|${engine.name}`, seconds);
    observeHistogram(metrics.upstreamHistogram, `${path}|${engine.name}`, seconds);
    clearTimeout(timeout);
  }
}

async function selectUpstream(baseUrl) {
  const fallback = { url: trimTrailingSlash(baseUrl), release: () => {} };
  if (process.env.NODE_ENV === 'test') return fallback;
  if (!VALHALLA_DNS_ROUND_ROBIN) return fallback;
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return fallback;
  }
  if (!['http:', 'https:'].includes(url.protocol) || isIP(url.hostname) || url.hostname === 'localhost') {
    return fallback;
  }
  const cacheKey = `${url.protocol}//${url.hostname}:${url.port || defaultPort(url.protocol)}`;
  const now = Date.now();
  let addresses = upstreamDnsCache.get(cacheKey);
  if (!addresses || now >= addresses.expiresAt) {
    try {
      const records = await lookup(url.hostname, { all: true, verbatim: true });
      const values = Array.from(new Set(records.map((record) => record.address).filter(Boolean))).sort();
      addresses = { values, expiresAt: now + VALHALLA_DNS_TTL_MS };
      upstreamDnsCache.set(cacheKey, addresses);
    } catch {
      return fallback;
    }
  }
  if (addresses.values.length < 2) return fallback;
  const selected = selectLeastInflightAddress(cacheKey, addresses.values);
  const inflightKey = `${cacheKey}|${selected}`;
  upstreamInflight.set(inflightKey, (upstreamInflight.get(inflightKey) || 0) + 1);
  url.hostname = selected;
  return {
    url: trimTrailingSlash(url.toString()),
    release: () => {
      const current = upstreamInflight.get(inflightKey) || 0;
      if (current <= 1) upstreamInflight.delete(inflightKey);
      else upstreamInflight.set(inflightKey, current - 1);
    }
  };
}

function selectLeastInflightAddress(cacheKey, values) {
  let least = Infinity;
  let candidates = [];
  for (const value of values) {
    const current = upstreamInflight.get(`${cacheKey}|${value}`) || 0;
    if (current < least) {
      least = current;
      candidates = [value];
    } else if (current === least) {
      candidates.push(value);
    }
  }
  const tieKey = `${cacheKey}|least_inflight_tie`;
  const index = upstreamRoundRobin.get(tieKey) || 0;
  upstreamRoundRobin.set(tieKey, (index + 1) % candidates.length);
  return candidates[index % candidates.length];
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function defaultPort(protocol) {
  return protocol === 'https:' ? '443' : '80';
}

async function readMetadata(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function checkValhallaStatus(url) {
  if (!url) return { ok: false, url: null, latency_ms: 0, error: 'not_configured', status: 'not_configured' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = process.hrtime.bigint();
  try {
    const response = await fetch(`${url}/status`, { signal: controller.signal });
    const latencyMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    return {
      ok: response.ok,
      url,
      latency_ms: latencyMs,
      error: response.ok ? null : `status ${response.status}`,
      status: response.ok ? 'ok' : 'unhealthy',
      ...(response.ok ? {} : { code: response.status })
    };
  } catch (err) {
    const latencyMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    return { ok: false, url, latency_ms: latencyMs, error: err.name === 'AbortError' ? 'timeout' : 'unavailable', status: 'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

async function listFilesRecursive(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filePath = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursive(filePath));
    else files.push(filePath);
  }
  return files;
}

function extractCorrelatedLocations(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.correlated_locations || payload?.locations || [];
}

function locateHasEdge(payload) {
  return extractCorrelatedLocations(payload).some((location) => Array.isArray(location?.edges) && location.edges.length > 0);
}

function routeIsSane(payload) {
  const summary = payload?.trip?.summary;
  const shape = payload?.trip?.legs?.[0]?.shape || payload?.trip?.shape;
  return isNumber(summary?.length) && summary.length > 0 && isNumber(summary?.time) && summary.time > 0 && Boolean(shape);
}

async function validateActiveGraph() {
  activeVersion = loadActiveVersion();
  const graphPath = activeGraphPath();
  const result = {
    ok: false,
    active_color: activeVersion.active,
    active_build: graphVersion(),
    graph_path: graphPath,
    config_path: VALHALLA_CONFIG_PATH,
    checks: {}
  };
  try {
    await access(VALHALLA_CONFIG_PATH, constants.R_OK);
    result.checks.config_exists = true;
  } catch {
    result.checks.config_exists = false;
  }
  try {
    await access(ACTIVE_VERSION_PATH, constants.R_OK);
    result.checks.active_version_exists = Boolean(graphVersion());
  } catch {
    result.checks.active_version_exists = false;
  }
  try {
    const graphStat = await stat(graphPath);
    result.checks.graph_directory_exists = graphStat.isDirectory();
    const files = await listFilesRecursive(graphPath);
    result.graph_file_count = files.length;
    result.checks.graph_non_empty = files.length > 0;
    result.checks.manifest_exists = files.includes(join(graphPath, 'manifest.json'));
    result.checks.graph_tiles_exist = files.some((file) => file.endsWith('valhalla_tiles.tar') || file.endsWith('.gph') || file.endsWith('.bin'));
  } catch {
    result.checks.graph_directory_exists = false;
    result.checks.graph_non_empty = false;
    result.checks.manifest_exists = false;
    result.checks.graph_tiles_exist = false;
  }
  result.regional = await checkValhallaStatus(regionalUrl());
  result.checks.status_ok = result.regional.ok;
  if (result.regional.ok) {
    const engine = { name: 'regional', url: regionalUrl(), area: REGION };
    const locate = await callValhalla('/locate', { locations: [PROBE_LOCATE], costing: 'auto', verbose: true }, engine);
    result.checks.locate_probe_ok = locate.ok && locateHasEdge(locate.body);
    const route = await callValhalla('/route', { locations: PROBE_ROUTE, costing: 'auto' }, engine);
    result.checks.route_probe_ok = route.ok && routeIsSane(route.body);
  } else {
    result.checks.locate_probe_ok = false;
    result.checks.route_probe_ok = false;
  }
  result.ok = Object.values(result.checks).every(Boolean);
  metrics.ready = result.ok ? 1 : 0;
  metrics.locateProbeOk = result.checks.locate_probe_ok ? 1 : 0;
  metrics.routeProbeOk = result.checks.route_probe_ok ? 1 : 0;
  return result;
}

function decodePolyline6(encoded) {
  if (!encoded) return [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const coordinates = [];
  while (index < encoded.length) {
    const latResult = decodeChunk(encoded, index);
    index = latResult.index;
    const lonResult = decodeChunk(encoded, index);
    index = lonResult.index;
    lat += latResult.value;
    lon += lonResult.value;
    coordinates.push([lon / 1e6, lat / 1e6]);
  }
  return coordinates;
}

function decodeChunk(encoded, startIndex) {
  let result = 0;
  let shift = 0;
  let index = startIndex;
  let byte;
  do {
    byte = encoded.charCodeAt(index++) - 63;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20);
  return { value: result & 1 ? ~(result >> 1) : result >> 1, index };
}

function encodePolyline(coordinates, precision = 6) {
  const factor = 10 ** precision;
  let previousLat = 0;
  let previousLon = 0;
  let encoded = '';
  for (const [lon, lat] of coordinates) {
    const scaledLat = Math.round(lat * factor);
    const scaledLon = Math.round(lon * factor);
    encoded += encodeChunk(scaledLat - previousLat);
    encoded += encodeChunk(scaledLon - previousLon);
    previousLat = scaledLat;
    previousLon = scaledLon;
  }
  return encoded;
}

function encodeChunk(value) {
  let current = value < 0 ? ~(value << 1) : value << 1;
  let encoded = '';
  while (current >= 0x20) {
    encoded += String.fromCharCode((0x20 | (current & 0x1f)) + 63);
    current >>= 5;
  }
  return encoded + String.fromCharCode(current + 63);
}

function mergeLegCoordinates(legs) {
  const merged = [];
  for (const leg of legs) {
    const coordinates = decodePolyline6(leg.shape || '');
    if (merged.length && coordinates.length) {
      const [lastLon, lastLat] = merged[merged.length - 1];
      const [firstLon, firstLat] = coordinates[0];
      if (lastLon === firstLon && lastLat === firstLat) coordinates.shift();
    }
    merged.push(...coordinates);
  }
  return merged;
}

function routeGeometry(coordinates, format, overview = 'full') {
  if (overview === 'false') return null;
  if (format === 'geojson') return { type: 'LineString', coordinates };
  return encodePolyline(coordinates, format === 'polyline' ? 5 : 6);
}

function routeGeometryFromTrip(trip, legs, options) {
  if (options.overview === 'false') return { geometry: null, coordinates: [] };
  if (options.shape_format === 'polyline6') {
    if (legs.length === 1 && legs[0].shape) return { geometry: legs[0].shape, coordinates: null };
    if (!legs.length && trip?.shape) return { geometry: trip.shape, coordinates: null };
  }
  const coordinates = legs.length ? mergeLegCoordinates(legs) : decodePolyline6(trip?.shape || '');
  return { geometry: routeGeometry(coordinates, options.shape_format, options.overview), coordinates };
}

function metersFromValhallaLength(length, units) {
  if (!isNumber(length)) return 0;
  return units === 'miles' ? length * 1609.344 : length * 1000;
}

function buildSteps(leg, shapeCoords = []) {
  return (leg.maneuvers || []).map((maneuver) => {
    const location = shapeCoords[maneuver.begin_shape_index] || null;
    return {
      instruction: maneuver.instruction || '',
      name: (maneuver.street_names || [])[0] || '',
      distance: maneuver.length ?? 0,
      duration: maneuver.time ?? 0,
      maneuver: {
        type: maneuverType(maneuver.type),
        modifier: maneuverModifier(maneuver),
        location,
        bearing_before: maneuver.begin_heading ?? maneuver.bearing_before ?? null,
        bearing_after: maneuver.end_heading ?? maneuver.bearing_after ?? null
      }
    };
  });
}

function maneuverType(type) {
  const id = Number(type);
  if ([1, 2].includes(id)) return 'depart';
  if ([4, 5].includes(id)) return 'arrive';
  if ([8, 9, 10, 11, 12, 13, 14, 15].includes(id)) return 'turn';
  if ([18, 19].includes(id)) return 'merge';
  if ([26, 27].includes(id)) return 'roundabout';
  if ([6, 7].includes(id)) return 'continue';
  if ([16, 17].includes(id)) return 'fork';
  if ([24, 25].includes(id)) return 'end of road';
  return 'continue';
}

function maneuverModifier(maneuver) {
  const text = `${maneuver.instruction || ''} ${maneuver.verbal_pre_transition_instruction || ''}`.toLowerCase();
  if (text.includes('u-turn') || text.includes('uturn')) return 'uturn';
  if (text.includes('sharp left')) return 'sharp left';
  if (text.includes('sharp right')) return 'sharp right';
  if (text.includes('slight left')) return 'slight left';
  if (text.includes('slight right')) return 'slight right';
  if (text.includes('left')) return 'left';
  if (text.includes('right')) return 'right';
  return 'straight';
}

function routeFromTrip(trip, units, options, engine, warnings) {
  const legs = trip?.legs || [];
  const summary = trip?.summary || {};
  const { geometry } = routeGeometryFromTrip(trip, legs, options);
  const legDistance = legs.reduce((sum, leg) => sum + (leg.summary?.length || leg.length || 0), 0);
  const legDuration = legs.reduce((sum, leg) => sum + (leg.summary?.time || leg.time || 0), 0);
  const totalDistance = summary.length ?? legDistance;
  const totalDuration = summary.time ?? legDuration;
  if (legs.length && Math.abs(totalDistance - legDistance) > 0.01) warnings.push('trip summary distance differs from summed leg distance');
  if (legs.length && Math.abs(totalDuration - legDuration) > 1) warnings.push('trip summary duration differs from summed leg duration');
  return {
    distance: totalDistance,
    duration: totalDuration,
    geometry,
    legs: legs.map((leg) => ({
      distance: leg.summary?.length ?? leg.length ?? 0,
      duration: leg.summary?.time ?? leg.time ?? 0,
      summary: leg.summary?.has_time_restrictions ? 'time restricted route' : '',
      steps: options.steps === false ? [] : buildSteps(leg, decodePolyline6(leg.shape || ''))
    })),
    annotations: buildAnnotations(options.annotations, warnings),
    engine: engine.name,
    area: engine.area || null,
    units
  };
}

function buildAnnotations(requested, warnings) {
  if (!requested?.length) return undefined;
  const annotations = {};
  for (const item of requested) {
    if (item === 'duration' || item === 'distance') annotations[item] = [];
    else warnings.push(`annotation '${item}' is not available from this Valhalla response`);
  }
  return Object.keys(annotations).length ? annotations : undefined;
}

function simplifyRoute(raw, units, options, engine, optionWarnings = []) {
  const warnings = [...optionWarnings];
  const routes = [];
  if (raw?.trip) routes.push(routeFromTrip(raw.trip, units, options, engine, warnings));
  for (const alternate of raw?.alternates || raw?.trip?.alternates || []) {
    if (alternate.trip) routes.push(routeFromTrip(alternate.trip, units, options, engine, warnings));
  }
  const primary = routes[0] || { distance: null, duration: null, geometry: null, legs: [] };
  return {
    distance: primary.distance,
    duration: primary.duration,
    units: raw?.trip?.units || units,
    geometry: primary.geometry,
    routes,
    engine: engine.name,
    area: engine.area || null,
    graph_version: graphVersion(),
    warnings,
    ...(shouldIncludeRaw(options) ? { raw } : {})
  };
}

function haversineMeters(a, b) {
  const earth = 6371000;
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.asin(Math.sqrt(h));
}

function requireInternal(req, res, next) {
  if (!BUILD_ENDPOINTS_ENABLED) return sendError(res, 404, 'not_found', 'Build management endpoints are disabled');
  if (!INTERNAL_TOKEN) return sendError(res, 503, 'internal_token_missing', 'ROUTING_INTERNAL_TOKEN is required for build management endpoints');
  if (req.header('x-internal-token') === INTERNAL_TOKEN) return next();
  if (req.header('authorization') === `Bearer ${INTERNAL_TOKEN}`) return next();
  return sendError(res, 403, 'forbidden', 'Internal operation token is required');
}

async function routeCore({ locations, costing, options, optionWarnings }) {
  const engine = selectRoutingEngine(locations, options.engine, options.area);
  const result = await callValhalla('/route', buildValhallaRouteBody(locations, costing, options), engine);
  return { result, engine, response: result.ok ? simplifyRoute(result.body, options.units, options, result.engine, optionWarnings) : null };
}

app.get(['/api/routing/docs', '/api/routing/swagger'], (_req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Tavrix Valhalla Routing API</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css"/></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:'/api/routing/openapi.json',dom_id:'#swagger-ui',deepLinking:true,displayRequestDuration:true,tryItOutEnabled:true});</script></body></html>`);
});

app.get('/api/routing/openapi.json', (_req, res) => res.json(OPENAPI_SPEC));

app.get('/metrics', (_req, res) => {
  res.type('text/plain; version=0.0.4').send(renderMetrics());
});

app.get('/api/routing/areas', (_req, res) => res.json({ areas: IMPORTANT_AREAS }));

app.get('/api/routing/areas/:areaId', (req, res) => {
  const area = findArea(req.params.areaId);
  if (!area) return sendError(res, 404, 'not_found', 'Area not found');
  return res.json({ area, enabled_profiles: Array.from(COSTING), engine: 'regional' });
});

app.get('/api/routing/areas/:areaId/health', async (req, res) => {
  const area = findArea(req.params.areaId);
  if (!area) return sendError(res, 404, 'not_found', 'Area not found');
  const readiness = await validateActiveGraph();
  return res.status(readiness.ok ? 200 : 503).json({ area: area.id, ...readiness });
});

app.get('/api/routing/areas/:areaId/coverage', async (req, res) => {
  const area = findArea(req.params.areaId);
  if (!area) return sendError(res, 404, 'not_found', 'Area not found');
  return res.json({ area: area.id, bounds: area.bounds, graph_path: activeGraphPath(), build_id: graphVersion(), active_color: activeVersion.active, enabled_profiles: Array.from(COSTING), min_lat: area.bounds.minLat, max_lat: area.bounds.maxLat, min_lon: area.bounds.minLon, max_lon: area.bounds.maxLon });
});

app.get('/api/routing/areas/:areaId/builds', requireInternal, async (req, res) => {
  if (!findArea(req.params.areaId)) return sendError(res, 404, 'not_found', 'Area not found');
  return res.json({ area: req.params.areaId, builds: await listBuilds() });
});

app.get('/api/routing/health/live', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/routing/health/dependencies', async (_req, res) => {
  res.json({ regional: await checkValhallaStatus(regionalUrl()), world: await checkValhallaStatus(WORLD_URL), active_color: activeVersion.active, graph_version: graphVersion() });
});

app.get('/api/routing/health/ready', async (_req, res) => {
  const readiness = await validateActiveGraph();
  return res.status(readiness.ok ? 200 : 503).json({ status: readiness.ok ? 'ok' : 'not_ready', ...readiness, areas_count: IMPORTANT_AREAS.length });
});

app.get('/api/routing/health', async (_req, res) => {
  const [readiness, worldStatus, worldMetadata] = await Promise.all([validateActiveGraph(), checkValhallaStatus(WORLD_URL), readMetadata(WORLD_METADATA_PATH)]);
  const payload = { status: readiness.ok ? 'ok' : 'not_ready', service: 'valhalla-router', mode: 'regional-plus-optional-world', region: REGION, active_build: graphVersion(), active_color: activeVersion.active, checks: readiness.checks, engines: { regional: { ...readiness.regional, areas: IMPORTANT_AREAS, active_build: graphVersion() }, world: { ...worldStatus, active_build: worldMetadata?.build_id || null } } };
  return res.status(readiness.ok ? 200 : 503).json(payload);
});

app.get('/api/routing/directions/:costing/:coordinates', async (req, res) => {
  const locations = parseCoordinatesParam(req.params.coordinates);
  const costing = req.params.costing;
  const { options, warnings, validationError } = collectRouteOptions(req.query);
  const errorMessage = validateLocations(locations, { min: 2, max: MAX_ROUTE_LOCATIONS }) || validateEnum(costing, COSTING, 'costing') || validationError;
  if (errorMessage) return sendValidationError(res, errorMessage);
  const { result, response } = await routeCore({ locations, costing, options, optionWarnings: warnings });
  if (!result.ok) return res.status(result.status).json(withRequestId(res, result.body));
  return res.json(response);
});

app.post('/api/routing/route', async (req, res) => {
  const body = req.body || {};
  const locations = body.locations;
  const costing = body.costing || 'auto';
  const { options, warnings, validationError } = collectRouteOptions(body);
  const errorMessage = validateLocations(locations, { min: 2, max: MAX_ROUTE_LOCATIONS }) || validateEnum(costing, COSTING, 'costing') || validationError;
  if (errorMessage) return sendValidationError(res, errorMessage);
  const { result, response } = await routeCore({ locations, costing, options, optionWarnings: warnings });
  if (!result.ok) return res.status(result.status).json(withRequestId(res, result.body));
  return res.json(response);
});

app.post('/api/routing/matrix', async (req, res) => {
  const body = req.body || {};
  const costing = body.costing || 'auto';
  const engineName = body.engine || 'auto';
  const hasLocations = hasOwn(body, 'locations');
  const hasSources = hasOwn(body, 'sources');
  const hasTargets = hasOwn(body, 'targets');
  if (!hasLocations && !(hasSources && hasTargets)) return sendValidationError(res, 'matrix requires either locations or sources and targets');
  if (hasLocations && (hasSources || hasTargets)) return sendValidationError(res, 'matrix accepts either locations or sources and targets, not both');
  const sources = hasLocations ? body.locations : body.sources;
  const targets = hasLocations ? body.locations : body.targets;
  const validationError = validateLocations(sources, { min: 1, max: MAX_MATRIX_SOURCES, name: 'sources' }) || validateLocations(targets, { min: 1, max: MAX_MATRIX_TARGETS, name: 'targets' }) || validateEnum(costing, COSTING, 'costing') || validateEnum(engineName, ENGINES, 'engine') || validateArea(body.area || null);
  if (validationError) return sendValidationError(res, validationError);
  if (sources.length * targets.length > MAX_MATRIX_CELLS) return sendError(res, 400, 'invalid_request', `matrix allows at most ${MAX_MATRIX_CELLS} source/target pairs`);
  const engine = selectRoutingEngine([...sources, ...targets], engineName, body.area || null);
  const result = await callValhalla('/sources_to_targets', { sources, targets, costing }, engine);
  if (!result.ok) return res.status(result.status).json(withRequestId(res, result.body));
  const matrix = result.body.sources_to_targets || [];
  const cellCount = sources.length * targets.length;
  metrics.matrixCells += cellCount;
  return res.json({ sources_count: sources.length, targets_count: targets.length, cells: cellCount, durations: matrix.map((row) => row.map((cell) => cell.time ?? null)), distances: matrix.map((row) => row.map((cell) => cell.distance ?? null)), engine: result.engine.name, area: result.engine.area || null, graph_version: graphVersion(), warnings: [], ...(shouldIncludeRaw(body) ? { raw: result.body } : {}) });
});

app.post('/api/routing/isochrone', async (req, res) => {
  const body = req.body || {};
  const costing = body.costing || 'auto';
  const contours = body.contours || [];
  const validationError = validateLocations(body.locations, { min: 1, max: MAX_ISOCHRONE_LOCATIONS }) || validateEnum(costing, COSTING, 'costing') || validateEnum(body.engine || 'auto', ENGINES, 'engine') || validateArea(body.area || null);
  if (validationError) return sendValidationError(res, validationError);
  if (!Array.isArray(contours) || contours.length < 1 || contours.length > MAX_ISOCHRONE_CONTOURS) return sendError(res, 400, 'invalid_request', `contours must include 1 to ${MAX_ISOCHRONE_CONTOURS} items`);
  const engine = selectRoutingEngine(body.locations, body.engine || 'auto', body.area || null);
  const result = await callValhalla('/isochrone', { locations: body.locations, costing, contours, polygons: body.polygons !== false }, engine);
  if (!result.ok) return res.status(result.status).json(withRequestId(res, result.body));
  return res.json({ type: result.body.type || 'FeatureCollection', features: result.body.features || [], ...result.body, engine: result.engine.name, area: result.engine.area || null, graph_version: graphVersion(), warnings: [] });
});

app.post('/api/routing/map-match', async (req, res) => {
  const body = req.body || {};
  const hasShape = hasOwn(body, 'shape');
  const hasLocations = hasOwn(body, 'locations');
  if (!hasShape && !hasLocations) return sendValidationError(res, 'map-match requires either shape or locations');
  if (hasShape && hasLocations) return sendValidationError(res, 'map-match accepts either shape or locations, not both');
  const shape = hasShape ? body.shape : body.locations;
  const costing = body.costing || 'auto';
  const validationError = validateLocations(shape, { min: 2, max: MAX_MAP_MATCH_POINTS, name: 'shape' })
    || validateEnum(costing, COSTING, 'costing')
    || validateEnum(body.engine || 'auto', ENGINES, 'engine')
    || validateEnum(body.units || 'kilometers', UNITS, 'units')
    || validateEnum(body.shape_format || 'polyline6', SHAPE_FORMATS, 'shape_format')
    || validateEnum(body.overview || 'full', OVERVIEWS, 'overview')
    || validateArea(body.area || null);
  if (validationError) return sendValidationError(res, validationError);
  if (body.overview === 'simplified') return sendValidationError(res, 'overview=simplified is not supported; use full or false');
  const engine = selectRoutingEngine(shape, body.engine || 'auto', body.area || null);
  const traceBody = { shape, costing, shape_match: body.shape_match || 'map_snap' };
  const attributesResult = await callValhalla('/trace_attributes', traceBody, engine);
  if (!attributesResult.ok) return res.status(attributesResult.status).json(withRequestId(res, attributesResult.body));
  const routeResult = await callValhalla('/trace_route', { ...traceBody, directions_options: { units: body.units || 'kilometers', narrative: body.steps !== false } }, engine);
  if (!routeResult.ok) return res.status(routeResult.status).json(withRequestId(res, routeResult.body));
  const route = simplifyRoute(routeResult.body, body.units || 'kilometers', { shape_format: body.shape_format || 'polyline6', overview: body.overview || 'full', steps: body.steps !== false, annotations: [] }, routeResult.engine);
  const trace = summarizeTraceAttributes(attributesResult.body);
  return res.json({ ...trace, geometry: route.geometry, routes: route.routes, engine: routeResult.engine.name, area: routeResult.engine.area || null, graph_version: graphVersion(), warnings: route.warnings || [], ...(shouldIncludeRaw(body) ? { raw: { attributes: attributesResult.body, route: routeResult.body } } : {}) });
});

function summarizeTraceAttributes(attributes) {
  const points = Array.isArray(attributes?.matched_points) ? attributes.matched_points : null;
  if (!points) return { confidence: attributes?.confidence ?? null, matched_points: null, unmatched_points: null, snapped_distance_m: null, quality_status: 'trace_attributes_missing_matched_points' };
  const unmatchedPoints = points.filter((point) => point.type === 'unmatched' || point.edge_index == null).length;
  const snappedDistance = points.reduce((sum, point) => sum + (isNumber(point.distance_from_trace_point) ? point.distance_from_trace_point : 0), 0);
  return { confidence: attributes?.confidence ?? null, matched_points: points.length - unmatchedPoints, unmatched_points: unmatchedPoints, snapped_distance_m: snappedDistance, quality_status: unmatchedPoints ? 'partial' : 'matched' };
}

app.post(['/api/routing/snap', '/api/routing/nearest'], async (req, res) => {
  const body = req.body || {};
  const locations = body.locations || (isNumber(body.lat) && isNumber(body.lon) ? [{ lat: body.lat, lon: body.lon }] : []);
  const costing = body.costing || 'auto';
  const radiusValue = body.radius ?? body.radius_meters;
  const radius = radiusValue == null ? DEFAULT_SNAP_RADIUS_METERS : Number(radiusValue);
  const validationError = validateLocations(locations, { min: 1, max: MAX_SNAP_LOCATIONS }) || validateEnum(costing, COSTING, 'costing') || validateEnum(body.engine || 'auto', ENGINES, 'engine') || validateArea(body.area || null);
  if (validationError) return sendValidationError(res, validationError);
  if (!isNumber(radius) || radius <= 0 || radius > MAX_SNAP_RADIUS_METERS) return sendError(res, 400, 'invalid_request', `radius must be between 1 and ${MAX_SNAP_RADIUS_METERS}`);
  const engine = selectRoutingEngine(locations, body.engine || 'auto', body.area || null);
  const result = await callValhalla('/locate', { locations, costing, radius, verbose: true }, engine);
  if (!result.ok) return res.status(result.status).json(withRequestId(res, result.body));
  const correlated = extractCorrelatedLocations(result.body);
  const results = locations.map((input, index) => normalizeNearest(input, correlated[index], shouldIncludeRaw(body), radius));
  for (const item of results) inc(metrics.snapResults, String(item.matched));
  return res.json({ results, engine: result.engine.name, area: result.engine.area || null, graph_version: graphVersion(), warnings: [], ...(shouldIncludeRaw(body) ? { raw: result.body } : {}) });
});

function normalizeNearest(input, correlated, includeRaw = false, maxDistanceMeters = DEFAULT_SNAP_RADIUS_METERS) {
  const edge = correlated?.edges?.[0] || correlated?.edge || {};
  const snappedLat = correlated?.lat ?? edge.correlated_lat ?? edge.lat;
  const snappedLon = correlated?.lon ?? edge.correlated_lon ?? edge.lon;
  const candidate = Object.keys(edge).length > 0 && isNumber(snappedLat) && isNumber(snappedLon);
  const candidateSnapped = candidate ? { lat: snappedLat, lon: snappedLon } : null;
  const candidateDistance = candidate ? (correlated?.distance ?? edge.distance ?? haversineMeters(input, candidateSnapped)) : null;
  const matched = candidate && isNumber(candidateDistance) && candidateDistance <= maxDistanceMeters;
  const snapped = matched ? candidateSnapped : null;
  return {
    input,
    matched,
    snapped,
    distance_meters: matched ? candidateDistance : null,
    edge_id: matched ? (edge.id ?? edge.graph_id ?? null) : null,
    road_name: matched ? (edge.names?.[0] || edge.name || '') : '',
    road_class: matched ? (edge.road_class || null) : null,
    speed: matched ? (edge.speed ?? null) : null,
    maxspeed: matched ? (edge.maxspeed ?? null) : null,
    side_of_street: matched ? (edge.side_of_street ?? correlated?.side_of_street ?? null) : null,
    graph_version: graphVersion(),
    ...(matched ? {} : { reason: candidate ? 'outside_radius' : 'no_edge_found' }),
    ...(includeRaw ? { edge_metadata: edge } : {})
  };
}

app.post('/api/routing/distance', async (req, res) => {
  const body = req.body || {};
  const locations = [body.from, body.to];
  const validationError = validateLocations(locations, { min: 2, max: 2 }) || validateEnum(body.costing || 'auto', COSTING, 'costing') || validateEnum(body.engine || 'auto', ENGINES, 'engine') || validateArea(body.area || null);
  if (validationError) return sendValidationError(res, validationError);
  const options = { units: 'kilometers', engine: body.engine || 'auto', area: body.area || null, shape_format: 'polyline6', steps: false, annotations: [], max_alternatives: 1 };
  const { result, response } = await routeCore({ locations, costing: body.costing || 'auto', options, optionWarnings: [] });
  if (!result.ok) return res.status(result.status).json(withRequestId(res, result.body));
  return res.json({ haversine_distance_m: haversineMeters(body.from, body.to), route_distance_m: metersFromValhallaLength(response.distance, response.units), duration_s: response.duration, engine: response.engine, area: response.area, graph_version: graphVersion(), warnings: [] });
});

app.post('/api/routing/optimization', async (req, res) => {
  const body = req.body || {};
  const jobs = body.jobs || [];
  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > MAX_OPTIMIZATION_JOBS) return sendError(res, 400, 'invalid_request', `jobs must include 1 to ${MAX_OPTIMIZATION_JOBS} items`);
  if (jobs.some((job) => job.service_seconds != null && (!Number.isFinite(Number(job.service_seconds)) || Number(job.service_seconds) < 0))) {
    return sendError(res, 400, 'invalid_service_seconds', 'service_seconds must be a non-negative number');
  }
  metrics.optimizationJobs += jobs.length;
  const points = [body.start, ...jobs.map((job) => ({ lat: job.lat, lon: job.lon })), body.end || body.start];
  const validationError = validateLocations(points, { min: 3, max: MAX_OPTIMIZATION_JOBS + 2 }) || validateEnum(body.costing || 'auto', COSTING, 'costing') || validateEnum(body.engine || 'auto', ENGINES, 'engine') || validateArea(body.area || null);
  if (validationError) return sendValidationError(res, validationError);
  const orderedIndexes = nearestNeighborOrder(body.start, jobs);
  const orderedJobs = orderedIndexes.map((index) => jobs[index]);
  const routeLocations = [body.start, ...orderedJobs.map((job) => ({ lat: job.lat, lon: job.lon })), body.end || body.start];
  const options = { units: 'kilometers', engine: body.engine || 'auto', area: body.area || null, shape_format: 'polyline6', steps: true, annotations: [], max_alternatives: 1 };
  const { result, response } = await routeCore({ locations: routeLocations, costing: body.costing || 'auto', options, optionWarnings: ['Optimization uses nearest-neighbor baseline; OR-Tools is not installed in this routing API image.'] });
  if (!result.ok) return res.status(result.status).json(withRequestId(res, result.body));
  const serviceSeconds = orderedJobs.reduce((sum, job) => sum + Number(job.service_seconds || 0), 0);
  return res.json({ ordered_jobs: orderedJobs, route: response, total_distance_m: metersFromValhallaLength(response.distance, response.units), total_duration_s: (response.duration || 0) + serviceSeconds, optimizer: 'nearest_neighbor', optimal: false, engine: response.engine, area: response.area, graph_version: graphVersion(), warnings: ['This is a heuristic route, not guaranteed optimal'] });
});

function nearestNeighborOrder(start, jobs) {
  const remaining = jobs.map((_, index) => index);
  const ordered = [];
  let current = start;
  while (remaining.length) {
    remaining.sort((a, b) => haversineMeters(current, jobs[a]) - haversineMeters(current, jobs[b]));
    const next = remaining.shift();
    ordered.push(next);
    current = jobs[next];
  }
  return ordered;
}

async function listBuilds() {
  try {
    return await readdir(BUILDS_PATH);
  } catch {
    return [];
  }
}

app.get('/api/routing/builds', requireInternal, async (_req, res) => res.json({ builds: await listBuilds() }));
app.get('/api/routing/builds/current', requireInternal, async (_req, res) => res.json({ active_version: activeVersion, manifest: await readMetadata(join(activeGraphPath(), 'manifest.json')) }));
app.post('/api/routing/builds/:buildId/activate', requireInternal, async (req, res) => {
  if (!isSafeBuildId(req.params.buildId)) return sendError(res, 400, 'invalid_build_id', 'buildId contains unsupported characters');
  return res.status(202).json({ status: 'manual_action_required', build_id: req.params.buildId, command: `./scripts/switch-active-valhalla.sh ${req.params.buildId}` });
});
app.post('/api/routing/reload', requireInternal, (_req, res) => res.status(202).json({ status: 'manual_action_required', command: 'docker compose restart routing-api' }));

app.use((_req, res) => sendError(res, 404, 'not_found', 'Not found'));

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`routing-api listening on ${PORT}`);
    console.log(`regional Valhalla: ${regionalUrl()}`);
    console.log(`world Valhalla: ${WORLD_URL || 'not configured'}`);
  });
}

export { app, collectRouteOptions, parseCoordinatesParam, simplifyRoute, haversineMeters };
