import express from 'express';
import { access, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildOpenApiSpec } from './openapi.js';

const app = express();

const PORT = Number(process.env.ROUTING_API_PORT || 3000);
const REGIONAL_URL = process.env.VALHALLA_REGIONAL_URL || process.env.VALHALLA_INTERNAL_URL || 'http://valhalla:8002';
const WORLD_URL = process.env.VALHALLA_WORLD_URL || '';
const TIMEOUT_MS = Number(process.env.VALHALLA_TIMEOUT_MS || 10000);
const REGION = process.env.VALHALLA_REGION || 'bahrain';
const ACTIVE_METADATA_PATH = process.env.VALHALLA_ACTIVE_METADATA_PATH || '/valhalla/active/current/metadata.json';
const WORLD_METADATA_PATH = process.env.VALHALLA_WORLD_METADATA_PATH || '';
const BUILDS_PATH = process.env.VALHALLA_BUILDS_PATH || '/valhalla/builds';
const ACTIVE_GRAPH_PATH = process.env.VALHALLA_ACTIVE_GRAPH_PATH || '/valhalla/active/current';
const INTERNAL_TOKEN = process.env.ROUTING_INTERNAL_TOKEN || '';
const BUILD_ENDPOINTS_ENABLED = String(process.env.ROUTING_BUILD_ENDPOINTS_ENABLED || 'true') === 'true';
const MAX_ROUTE_LOCATIONS = readPositiveInt('MAX_ROUTE_LOCATIONS', process.env.MAX_ROUTE_LOCATIONS || process.env.ROUTING_MAX_ROUTE_LOCATIONS || 25);
const MAX_MATRIX_SOURCES = readPositiveInt('MAX_MATRIX_SOURCES', process.env.MAX_MATRIX_SOURCES || 25);
const MAX_MATRIX_TARGETS = readPositiveInt('MAX_MATRIX_TARGETS', process.env.MAX_MATRIX_TARGETS || 25);
const MAX_MATRIX_CELLS = readPositiveInt('MAX_MATRIX_CELLS', process.env.MAX_MATRIX_CELLS || process.env.ROUTING_MAX_MATRIX_CELLS || 625);
const MAX_SNAP_LOCATIONS = readPositiveInt('MAX_SNAP_LOCATIONS', process.env.MAX_SNAP_LOCATIONS || 100);
const DEFAULT_SNAP_RADIUS_METERS = readPositiveInt('DEFAULT_SNAP_RADIUS_METERS', process.env.DEFAULT_SNAP_RADIUS_METERS || 50);
const MAX_SNAP_RADIUS_METERS = readPositiveInt('MAX_SNAP_RADIUS_METERS', process.env.MAX_SNAP_RADIUS_METERS || 500);
const MAX_MAP_MATCH_POINTS = readPositiveInt('MAX_MAP_MATCH_POINTS', process.env.MAX_MAP_MATCH_POINTS || 500);
const MAX_OPTIMIZATION_JOBS = readPositiveInt('MAX_OPTIMIZATION_JOBS', process.env.MAX_OPTIMIZATION_JOBS || process.env.ROUTING_MAX_OPTIMIZATION_JOBS || 50);
const REGIONAL_BOUNDS = parseBounds(process.env.VALHALLA_REGIONAL_BOUNDS || '50.2,25.5,51.0,26.6');
const IMPORTANT_AREAS = parseImportantAreas(process.env.VALHALLA_IMPORTANT_AREAS, REGION, REGIONAL_BOUNDS);

const COSTING = new Set(['auto', 'pedestrian', 'bicycle', 'motor_scooter', 'truck', 'bus', 'taxi']);
const UNITS = new Set(['kilometers', 'miles']);
const ENGINES = new Set(['auto', 'regional', 'world']);
const SHAPE_FORMATS = new Set(['polyline6', 'polyline', 'geojson']);
const OVERVIEWS = new Set(['full', 'simplified', 'false']);
const ANNOTATIONS = new Set(['duration', 'distance', 'speed', 'nodes', 'road_class', 'maxspeed']);

app.use(express.json({ limit: '512kb' }));
app.use(requestIdMiddleware);
app.use(metricsMiddleware);

const OPENAPI_SPEC = buildOpenApiSpec({
  port: PORT,
  regionalUrl: REGIONAL_URL,
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
    : `${req.method} ${req.path}`;
}

const metrics = {
  requestTotal: new Map(),
  requestDuration: new Map(),
  upstreamDuration: new Map(),
  upstreamErrors: new Map(),
  matrixCells: 0,
  optimizationJobs: 0
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

function metricsMiddleware(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    const endpoint = endpointLabel(req);
    inc(metrics.requestTotal, `${endpoint}|${res.statusCode}`);
    observe(metrics.requestDuration, endpoint, seconds);
    console.log(JSON.stringify({ request_id: req.requestId, method: req.method, path: req.path, status: res.statusCode, duration_ms: Math.round(seconds * 1000) }));
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
    '# TYPE routing_request_duration_seconds summary',
    ...summaryLines('routing_request_duration_seconds', metrics.requestDuration, ['endpoint']),
    '# TYPE routing_upstream_duration_seconds summary',
    ...summaryLines('routing_upstream_duration_seconds', metrics.upstreamDuration, ['endpoint', 'engine']),
    '# TYPE routing_upstream_errors_total counter',
    ...Array.from(metrics.upstreamErrors.entries()).map(([key, value]) => {
      const [engine, code] = key.split('|');
      return `routing_upstream_errors_total{engine=${JSON.stringify(engine)},code=${JSON.stringify(code)}} ${value}`;
    }),
    '# TYPE routing_matrix_cells_total counter',
    `routing_matrix_cells_total ${metrics.matrixCells}`,
    '# TYPE routing_optimization_jobs_total counter',
    `routing_optimization_jobs_total ${metrics.optimizationJobs}`
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
  if (!Number.isInteger(options.max_alternatives) || options.max_alternatives < 1 || options.max_alternatives > 3) return { validationError: 'max_alternatives must be between 1 and 3' };
  for (const field of booleans) if (options[field] === null) return { validationError: `${field} must be true or false` };
  if (options.include_raw === null) return { validationError: 'include_raw must be true or false' };
  for (const annotation of options.annotations) {
    if (!ANNOTATIONS.has(annotation)) return { validationError: `annotations contains unsupported value: ${annotation}` };
  }
  if (options.annotations.length) warnings.push('Valhalla does not expose all requested Mapbox-style annotations through this proxy; unsupported annotations are returned as warnings.');
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
  if (requestedEngine === 'regional') {
    if (selectedArea && !locations.every((point) => insideBounds(point, selectedArea.bounds))) {
      return { name: 'regional', url: null, area: selectedArea.id, error: `Route points are outside selected area: ${selectedArea.id}` };
    }
    return { name: 'regional', url: REGIONAL_URL, area: selectedArea?.id || findContainingArea(locations)?.id || REGION };
  }
  if (requestedEngine === 'world') return WORLD_URL ? { name: 'world', url: WORLD_URL } : { name: 'world', url: null, error: 'World Valhalla is not configured' };
  if (selectedArea) {
    if (locations.every((point) => insideBounds(point, selectedArea.bounds))) return { name: 'regional', url: REGIONAL_URL, area: selectedArea.id };
    return { name: 'world', url: WORLD_URL || null, area: selectedArea.id, error: WORLD_URL ? null : `World Valhalla is not configured and route is outside selected area: ${selectedArea.id}` };
  }
  const matchingArea = findContainingArea(locations);
  if (matchingArea) return { name: 'regional', url: REGIONAL_URL, area: matchingArea.id };
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
  try {
    const response = await fetch(`${engine.url}${path}`, {
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
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    observe(metrics.upstreamDuration, `${path}|${engine.name}`, seconds);
    clearTimeout(timeout);
  }
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

function routeGeometry(shape, format) {
  if (format === 'geojson') return { type: 'LineString', coordinates: decodePolyline6(shape) };
  return shape || '';
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
  const shape = legs[0]?.shape || trip?.shape || '';
  const shapeCoords = decodePolyline6(shape);
  return {
    distance: summary.length ?? legs.reduce((sum, leg) => sum + (leg.summary?.length || 0), 0),
    duration: summary.time ?? legs.reduce((sum, leg) => sum + (leg.summary?.time || 0), 0),
    geometry: routeGeometry(shape, options.shape_format),
    legs: legs.map((leg) => ({
      distance: leg.summary?.length ?? leg.length ?? 0,
      duration: leg.summary?.time ?? leg.time ?? 0,
      summary: leg.summary?.has_time_restrictions ? 'time restricted route' : '',
      steps: options.steps === false ? [] : buildSteps(leg, shapeCoords)
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
  return res.json({ area: area.id, ...(await checkValhallaStatus(REGIONAL_URL)) });
});

app.get('/api/routing/areas/:areaId/coverage', async (req, res) => {
  const area = findArea(req.params.areaId);
  if (!area) return sendError(res, 404, 'not_found', 'Area not found');
  const metadata = await readMetadata(ACTIVE_METADATA_PATH);
  return res.json({ area: area.id, bounds: area.bounds, graph_path: ACTIVE_GRAPH_PATH, build_id: metadata?.build_id || null, enabled_profiles: Array.from(COSTING), min_lat: area.bounds.minLat, max_lat: area.bounds.maxLat, min_lon: area.bounds.minLon, max_lon: area.bounds.maxLon });
});

app.get('/api/routing/areas/:areaId/builds', async (req, res) => {
  if (!findArea(req.params.areaId)) return sendError(res, 404, 'not_found', 'Area not found');
  return res.json({ area: req.params.areaId, builds: await listBuilds() });
});

app.get('/api/routing/health/live', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/routing/health/dependencies', async (_req, res) => {
  res.json({ regional: await checkValhallaStatus(REGIONAL_URL), world: await checkValhallaStatus(WORLD_URL) });
});

app.get('/api/routing/health/ready', async (_req, res) => {
  const regional = await checkValhallaStatus(REGIONAL_URL);
  const metadata = await readMetadata(ACTIVE_METADATA_PATH);
  let activeGraphExists = true;
  try {
    await access(ACTIVE_GRAPH_PATH, constants.R_OK);
  } catch {
    activeGraphExists = false;
  }
  const ready = regional.ok && activeGraphExists && Boolean(metadata?.build_id) && IMPORTANT_AREAS.length > 0;
  return res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'not_ready', regional, active_graph_exists: activeGraphExists, active_build: metadata?.build_id || null, areas_count: IMPORTANT_AREAS.length });
});

app.get('/api/routing/health', async (_req, res) => {
  const [regionalStatus, worldStatus, regionalMetadata, worldMetadata] = await Promise.all([checkValhallaStatus(REGIONAL_URL), checkValhallaStatus(WORLD_URL), readMetadata(ACTIVE_METADATA_PATH), readMetadata(WORLD_METADATA_PATH)]);
  if (!regionalStatus.ok) return sendError(res, 503, 'unhealthy', 'Valhalla health check failed');
  return res.json({ status: 'ok', service: 'valhalla-router', mode: 'regional-plus-optional-world', region: regionalMetadata?.region || REGION, active_build: regionalMetadata?.build_id || null, engines: { regional: { ...regionalStatus, areas: IMPORTANT_AREAS, active_build: regionalMetadata?.build_id || null }, world: { ...worldStatus, active_build: worldMetadata?.build_id || null } } });
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
  return res.json({ sources_count: sources.length, targets_count: targets.length, cells: cellCount, durations: matrix.map((row) => row.map((cell) => cell.time ?? null)), distances: matrix.map((row) => row.map((cell) => cell.distance ?? null)), engine: result.engine.name, area: result.engine.area || null, warnings: [], ...(shouldIncludeRaw(body) ? { raw: result.body } : {}) });
});

app.post('/api/routing/isochrone', async (req, res) => {
  const body = req.body || {};
  const costing = body.costing || 'auto';
  const contours = body.contours || [];
  const validationError = validateLocations(body.locations, { min: 1, max: 2 }) || validateEnum(costing, COSTING, 'costing') || validateEnum(body.engine || 'auto', ENGINES, 'engine') || validateArea(body.area || null);
  if (validationError) return sendValidationError(res, validationError);
  if (!Array.isArray(contours) || contours.length < 1 || contours.length > 4) return sendError(res, 400, 'invalid_request', 'contours must include 1 to 4 items');
  const engine = selectRoutingEngine(body.locations, body.engine || 'auto', body.area || null);
  const result = await callValhalla('/isochrone', { locations: body.locations, costing, contours, polygons: body.polygons !== false }, engine);
  if (!result.ok) return res.status(result.status).json(withRequestId(res, result.body));
  return res.json({ type: result.body.type || 'FeatureCollection', features: result.body.features || [], ...result.body, engine: result.engine.name, area: result.engine.area || null, warnings: [] });
});

app.post('/api/routing/map-match', async (req, res) => {
  const body = req.body || {};
  const hasShape = hasOwn(body, 'shape');
  const hasLocations = hasOwn(body, 'locations');
  if (!hasShape && !hasLocations) return sendValidationError(res, 'map-match requires either shape or locations');
  if (hasShape && hasLocations) return sendValidationError(res, 'map-match accepts either shape or locations, not both');
  const shape = hasShape ? body.shape : body.locations;
  const costing = body.costing || 'auto';
  const validationError = validateLocations(shape, { min: 2, max: MAX_MAP_MATCH_POINTS, name: 'shape' }) || validateEnum(costing, COSTING, 'costing') || validateEnum(body.engine || 'auto', ENGINES, 'engine') || validateArea(body.area || null);
  if (validationError) return sendValidationError(res, validationError);
  const engine = selectRoutingEngine(shape, body.engine || 'auto', body.area || null);
  const result = await callValhalla('/trace_route', { shape, costing, shape_match: body.shape_match || 'map_snap', directions_options: { units: body.units || 'kilometers', narrative: body.steps !== false } }, engine);
  if (!result.ok) return res.status(result.status).json(withRequestId(res, result.body));
  const route = simplifyRoute(result.body, body.units || 'kilometers', { shape_format: body.shape_format || 'polyline6', steps: body.steps !== false, annotations: [] }, result.engine);
  return res.json({ confidence: result.body.confidence ?? null, matched_points: shape.length, unmatched_points: 0, snapped_distance_m: 0, geometry: route.geometry, routes: route.routes, engine: result.engine.name, area: result.engine.area || null, warnings: route.warnings || [], ...(shouldIncludeRaw(body) ? { raw: result.body } : {}) });
});

app.post(['/api/routing/snap', '/api/routing/nearest'], async (req, res) => {
  const body = req.body || {};
  const locations = body.locations || [];
  const costing = body.costing || 'auto';
  const radius = body.radius == null ? DEFAULT_SNAP_RADIUS_METERS : Number(body.radius);
  const validationError = validateLocations(locations, { min: 1, max: MAX_SNAP_LOCATIONS }) || validateEnum(costing, COSTING, 'costing') || validateEnum(body.engine || 'auto', ENGINES, 'engine') || validateArea(body.area || null);
  if (validationError) return sendValidationError(res, validationError);
  if (!isNumber(radius) || radius <= 0 || radius > MAX_SNAP_RADIUS_METERS) return sendError(res, 400, 'invalid_request', `radius must be between 1 and ${MAX_SNAP_RADIUS_METERS}`);
  const engine = selectRoutingEngine(locations, body.engine || 'auto', body.area || null);
  const result = await callValhalla('/locate', { locations, costing, radius, verbose: true }, engine);
  if (!result.ok) return res.status(result.status).json(withRequestId(res, result.body));
  const correlated = result.body?.correlated_locations || result.body?.locations || [];
  return res.json({ results: locations.map((input, index) => normalizeNearest(input, correlated[index], shouldIncludeRaw(body))), engine: result.engine.name, area: result.engine.area || null, warnings: [], ...(shouldIncludeRaw(body) ? { raw: result.body } : {}) });
});

function normalizeNearest(input, correlated, includeRaw = false) {
  const edge = correlated?.edges?.[0] || correlated?.edge || {};
  const snapped = correlated?.lat != null && correlated?.lon != null ? { lat: correlated.lat, lon: correlated.lon } : input;
  return { input, snapped, distance_meters: correlated?.distance ?? haversineMeters(input, snapped), edge_id: edge.id ?? null, road_name: edge.names?.[0] || edge.name || '', road_class: edge.road_class || null, speed: edge.speed ?? null, maxspeed: edge.maxspeed ?? null, ...(includeRaw ? { edge_metadata: edge } : {}) };
}

app.post('/api/routing/distance', async (req, res) => {
  const body = req.body || {};
  const locations = [body.from, body.to];
  const validationError = validateLocations(locations, { min: 2, max: 2 }) || validateEnum(body.costing || 'auto', COSTING, 'costing') || validateEnum(body.engine || 'auto', ENGINES, 'engine') || validateArea(body.area || null);
  if (validationError) return sendValidationError(res, validationError);
  const options = { units: 'kilometers', engine: body.engine || 'auto', area: body.area || null, shape_format: 'polyline6', steps: false, annotations: [], max_alternatives: 1 };
  const { result, response } = await routeCore({ locations, costing: body.costing || 'auto', options, optionWarnings: [] });
  if (!result.ok) return res.status(result.status).json(withRequestId(res, result.body));
  return res.json({ haversine_distance_m: haversineMeters(body.from, body.to), route_distance_m: metersFromValhallaLength(response.distance, response.units), duration_s: response.duration, engine: response.engine, area: response.area, warnings: [] });
});

app.post('/api/routing/optimization', async (req, res) => {
  const body = req.body || {};
  const jobs = body.jobs || [];
  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > MAX_OPTIMIZATION_JOBS) return sendError(res, 400, 'invalid_request', `jobs must include 1 to ${MAX_OPTIMIZATION_JOBS} items`);
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
  return res.json({ ordered_jobs: orderedJobs, route: response, total_distance_m: metersFromValhallaLength(response.distance, response.units), total_duration_s: (response.duration || 0) + serviceSeconds, optimizer: 'nearest_neighbor', optimal: false, engine: response.engine, area: response.area, warnings: ['This is a heuristic route, not guaranteed optimal'] });
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
app.get('/api/routing/builds/current', requireInternal, async (_req, res) => res.json({ metadata: await readMetadata(ACTIVE_METADATA_PATH) }));
app.post('/api/routing/builds/:buildId/activate', requireInternal, async (req, res) => res.status(202).json({ status: 'manual_action_required', build_id: req.params.buildId, command: `./scripts/switch-active-valhalla.sh ${req.params.buildId}` }));
app.post('/api/routing/reload', requireInternal, (_req, res) => res.status(202).json({ status: 'manual_action_required', command: 'docker compose restart valhalla routing-api' }));

app.use((_req, res) => sendError(res, 404, 'not_found', 'Not found'));

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`routing-api listening on ${PORT}`);
    console.log(`regional Valhalla: ${REGIONAL_URL}`);
    console.log(`world Valhalla: ${WORLD_URL || 'not configured'}`);
  });
}

export { app, collectRouteOptions, parseCoordinatesParam, simplifyRoute, haversineMeters };
