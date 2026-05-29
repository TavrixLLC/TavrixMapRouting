import express from 'express';
import { readFile } from 'node:fs/promises';

const app = express();

const PORT = Number(process.env.ROUTING_API_PORT || 3000);
const REGIONAL_URL = process.env.VALHALLA_REGIONAL_URL || process.env.VALHALLA_INTERNAL_URL || 'http://valhalla:8002';
const WORLD_URL = process.env.VALHALLA_WORLD_URL || '';
const TIMEOUT_MS = Number(process.env.VALHALLA_TIMEOUT_MS || 10000);
const INCLUDE_RAW = String(process.env.VALHALLA_INCLUDE_RAW || 'false') === 'true';
const REGION = process.env.VALHALLA_REGION || 'bahrain';
const ACTIVE_METADATA_PATH = process.env.VALHALLA_ACTIVE_METADATA_PATH || '/valhalla/active/current/metadata.json';
const WORLD_METADATA_PATH = process.env.VALHALLA_WORLD_METADATA_PATH || '';
const REGIONAL_BOUNDS = parseBounds(process.env.VALHALLA_REGIONAL_BOUNDS || '50.2,25.5,51.0,26.6');
const IMPORTANT_AREAS = parseImportantAreas(process.env.VALHALLA_IMPORTANT_AREAS, REGION, REGIONAL_BOUNDS);
const AUTO_FALLBACK = String(process.env.VALHALLA_AUTO_FALLBACK || 'true') === 'true';

const COSTING = new Set(['auto', 'pedestrian', 'bicycle', 'motor_scooter', 'truck', 'bus', 'taxi']);
const UNITS = new Set(['kilometers', 'miles']);
const ENGINES = new Set(['auto', 'regional', 'world']);

app.use(express.json({ limit: '256kb' }));

function error(status, message, details) {
  return { error: { status, message, ...(details ? { details } : {}) } };
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateLocations(locations, { min, max, name = 'locations' }) {
  if (!Array.isArray(locations)) return `${name} must be an array`;
  if (locations.length < min) return `${name} requires at least ${min} point(s)`;
  if (locations.length > max) return `${name} allows at most ${max} point(s)`;

  for (const [index, point] of locations.entries()) {
    if (!point || !isNumber(point.lat) || !isNumber(point.lon)) {
      return `${name}[${index}] must include numeric lat and lon`;
    }
    if (point.lat < -90 || point.lat > 90) return `${name}[${index}].lat must be between -90 and 90`;
    if (point.lon < -180 || point.lon > 180) return `${name}[${index}].lon must be between -180 and 180`;
  }

  return null;
}

function validateCosting(costing) {
  return COSTING.has(costing) ? null : `costing must be one of: ${Array.from(COSTING).join(', ')}`;
}

function validateUnits(units) {
  return UNITS.has(units) ? null : `units must be one of: ${Array.from(UNITS).join(', ')}`;
}

function validateEngine(engine) {
  return ENGINES.has(engine) ? null : `engine must be one of: ${Array.from(ENGINES).join(', ')}`;
}

function parseBounds(value) {
  const parts = String(value).split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon >= maxLon || minLat >= maxLat) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function parseImportantAreas(value, defaultRegion, defaultBounds) {
  const areas = [];

  for (const item of String(value || '').split(';')) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    const [idPart, labelPart, boundsPart] = trimmed.split('|');
    const id = String(idPart || '').trim().toLowerCase();
    const label = String(labelPart || id).trim();
    const bounds = parseBounds(boundsPart);

    if (id && bounds) {
      areas.push({ id, label, bounds });
    }
  }

  if (!areas.length && defaultBounds) {
    areas.push({ id: defaultRegion, label: defaultRegion, bounds: defaultBounds });
  }

  return areas;
}

function insideBounds(point, bounds) {
  if (!bounds) return false;
  return point.lon >= bounds.minLon
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

function validateArea(areaId) {
  if (!areaId || findArea(areaId)) return null;
  return `area must be one of: ${IMPORTANT_AREAS.map((area) => area.id).join(', ')}`;
}

function selectRoutingEngine(locations, requestedEngine = 'auto', requestedArea = null) {
  const selectedArea = findArea(requestedArea);

  if (requestedEngine === 'regional') {
    if (selectedArea && !locations.every((point) => insideBounds(point, selectedArea.bounds))) {
      return {
        name: 'regional',
        url: null,
        area: selectedArea.id,
        error: `Route points are outside selected area: ${selectedArea.id}`
      };
    }
    return { name: 'regional', url: REGIONAL_URL, area: selectedArea?.id || findContainingArea(locations)?.id || REGION };
  }

  if (requestedEngine === 'world') {
    return WORLD_URL
      ? { name: 'world', url: WORLD_URL }
      : { name: 'world', url: null, error: 'World Valhalla is not configured' };
  }

  if (selectedArea) {
    if (locations.every((point) => insideBounds(point, selectedArea.bounds))) {
      return { name: 'regional', url: REGIONAL_URL, area: selectedArea.id };
    }

    return {
      name: 'world',
      url: WORLD_URL || null,
      area: selectedArea.id,
      error: WORLD_URL ? null : `World Valhalla is not configured and route is outside selected area: ${selectedArea.id}`
    };
  }

  const matchingArea = findContainingArea(locations);
  if (matchingArea) return { name: 'regional', url: REGIONAL_URL, area: matchingArea.id };
  if (WORLD_URL) return { name: 'world', url: WORLD_URL };

  return {
    name: 'world',
    url: null,
    error: 'World Valhalla is not configured for routes outside the regional bounds'
  };
}

async function callValhalla(path, body, engine) {
  if (!engine.url) {
    return {
      ok: false,
      status: 503,
      body: error(503, engine.error || 'Selected Valhalla engine is not configured')
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
      return {
        ok: false,
        status: response.status >= 400 ? response.status : 502,
        body: error(response.status >= 400 ? response.status : 502, 'Valhalla request failed', payload)
      };
    }

    return { ok: true, status: 200, body: payload, engine };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      body: error(timedOut ? 504 : 502, timedOut ? 'Valhalla request timed out' : 'Valhalla is unavailable')
    };
  } finally {
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
  if (!url) return { status: 'not_configured' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${url}/status`, { signal: controller.signal });
    return response.ok ? { status: 'ok' } : { status: 'unhealthy', code: response.status };
  } catch {
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

function simplifyRoute(raw, units, engine) {
  const summary = raw?.trip?.summary || {};
  const firstLeg = raw?.trip?.legs?.[0] || {};
  return {
    distance: summary.length ?? null,
    duration: summary.time ?? null,
    units: raw?.trip?.units || units,
    geometry: firstLeg.shape || null,
    engine: engine.name,
    area: engine.area || null,
    ...(engine.warning ? { warning: engine.warning } : {}),
    ...(INCLUDE_RAW ? { raw } : {})
  };
}

app.get('/api/routing/areas', (_req, res) => {
  return res.json({
    areas: IMPORTANT_AREAS
  });
});

app.get('/api/routing/health', async (_req, res) => {
  const [regionalStatus, worldStatus, regionalMetadata, worldMetadata] = await Promise.all([
    checkValhallaStatus(REGIONAL_URL),
    checkValhallaStatus(WORLD_URL),
    readMetadata(ACTIVE_METADATA_PATH),
    readMetadata(WORLD_METADATA_PATH)
  ]);

  if (regionalStatus.status !== 'ok') {
    return res.status(503).json(error(503, 'Valhalla health check failed'));
  }

  return res.json({
    status: 'ok',
    service: 'valhalla-router',
    mode: 'regional-plus-optional-world',
    region: regionalMetadata?.region || REGION,
    active_build: regionalMetadata?.build_id || null,
    engines: {
      regional: {
        status: regionalStatus.status,
        url: REGIONAL_URL,
        areas: IMPORTANT_AREAS,
        active_build: regionalMetadata?.build_id || null
      },
      world: {
        status: worldStatus.status,
        url: WORLD_URL || null,
        active_build: worldMetadata?.build_id || null
      }
    }
  });
});

app.post('/api/routing/route', async (req, res) => {
  const body = req.body || {};
  const costing = body.costing || 'auto';
  const units = body.units || 'kilometers';
  const requestedEngine = body.engine || 'auto';
  const requestedArea = body.area || null;
  const validationError = validateLocations(body.locations, { min: 2, max: 25 })
    || validateCosting(costing)
    || validateUnits(units)
    || validateEngine(requestedEngine)
    || validateArea(requestedArea);

  if (validationError) return res.status(400).json(error(400, validationError));

  const engine = selectRoutingEngine(body.locations, requestedEngine, requestedArea);
  const result = await callValhalla('/route', {
    locations: body.locations,
    costing,
    directions_options: { units },
    ...(body.costing_options ? { costing_options: body.costing_options } : {})
  }, engine);

  if (!result.ok && engine.name === 'world' && AUTO_FALLBACK) {
    const fallback = await callValhalla('/route', {
      locations: body.locations,
      costing,
      directions_options: { units },
      ...(body.costing_options ? { costing_options: body.costing_options } : {})
    }, { name: 'regional', url: REGIONAL_URL, warning: 'World Valhalla failed; fell back to regional engine' });

    if (fallback.ok) return res.json(simplifyRoute(fallback.body, units, fallback.engine));
  }

  if (!result.ok) return res.status(result.status).json(result.body);
  return res.json(simplifyRoute(result.body, units, result.engine));
});

app.post('/api/routing/matrix', async (req, res) => {
  const body = req.body || {};
  const costing = body.costing || 'auto';
  const requestedEngine = body.engine || 'auto';
  const requestedArea = body.area || null;
  const sources = body.sources || body.locations;
  const targets = body.targets || body.locations;
  const validationError = validateLocations(sources, { min: 1, max: 25, name: 'sources' })
    || validateLocations(targets, { min: 1, max: 25, name: 'targets' })
    || validateCosting(costing)
    || validateEngine(requestedEngine)
    || validateArea(requestedArea);

  if (validationError) return res.status(400).json(error(400, validationError));
  if (sources.length * targets.length > 625) {
    return res.status(400).json(error(400, 'matrix allows at most 625 source/target pairs'));
  }

  const engine = selectRoutingEngine([...sources, ...targets], requestedEngine, requestedArea);
  const result = await callValhalla('/sources_to_targets', { sources, targets, costing }, engine);
  if (result.ok && result.body && typeof result.body === 'object') result.body.engine = result.engine.name;
  return res.status(result.status).json(result.body);
});

app.post('/api/routing/isochrone', async (req, res) => {
  const body = req.body || {};
  const costing = body.costing || 'auto';
  const requestedEngine = body.engine || 'auto';
  const requestedArea = body.area || null;
  const contours = body.contours || [];
  const validationError = validateLocations(body.locations, { min: 1, max: 2 })
    || validateCosting(costing)
    || validateEngine(requestedEngine)
    || validateArea(requestedArea);

  if (validationError) return res.status(400).json(error(400, validationError));
  if (!Array.isArray(contours) || contours.length < 1 || contours.length > 4) {
    return res.status(400).json(error(400, 'contours must include 1 to 4 items'));
  }
  for (const [index, contour] of contours.entries()) {
    if (contour.time != null && (!isNumber(contour.time) || contour.time <= 0 || contour.time > 120)) {
      return res.status(400).json(error(400, `contours[${index}].time must be between 1 and 120`));
    }
    if (contour.distance != null && (!isNumber(contour.distance) || contour.distance <= 0 || contour.distance > 200)) {
      return res.status(400).json(error(400, `contours[${index}].distance must be between 1 and 200`));
    }
  }

  const engine = selectRoutingEngine(body.locations, requestedEngine, requestedArea);
  const result = await callValhalla('/isochrone', {
    locations: body.locations,
    costing,
    contours,
    polygons: body.polygons !== false
  }, engine);
  if (result.ok && result.body && typeof result.body === 'object') result.body.engine = result.engine.name;
  return res.status(result.status).json(result.body);
});

app.post('/api/routing/map-match', async (req, res) => {
  const body = req.body || {};
  const costing = body.costing || 'auto';
  const requestedEngine = body.engine || 'auto';
  const requestedArea = body.area || null;
  const shape = body.shape || body.locations;
  const validationError = validateLocations(shape, { min: 2, max: 500, name: 'shape' })
    || validateCosting(costing)
    || validateEngine(requestedEngine)
    || validateArea(requestedArea);

  if (validationError) return res.status(400).json(error(400, validationError));

  const engine = selectRoutingEngine(shape, requestedEngine, requestedArea);
  const result = await callValhalla('/trace_route', {
    shape,
    costing,
    shape_match: body.shape_match || 'map_snap',
    directions_options: { units: body.units || 'kilometers' }
  }, engine);
  if (!result.ok) return res.status(result.status).json(result.body);
  return res.status(result.status).json(INCLUDE_RAW ? result.body : simplifyRoute(result.body, body.units || 'kilometers', result.engine));
});

app.use((_req, res) => {
  res.status(404).json(error(404, 'Not found'));
});

app.listen(PORT, () => {
  console.log(`routing-api listening on ${PORT}`);
  console.log(`regional Valhalla: ${REGIONAL_URL}`);
  console.log(`world Valhalla: ${WORLD_URL || 'not configured'}`);
});
