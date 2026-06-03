export function buildOpenApiSpec({ port, regionalUrl, worldUrl, region, importantAreas }) {
  const areaExample = importantAreas[0]?.id || region || 'bahrain';
  const json = (schema) => ({ description: 'Success', content: { 'application/json': { schema } } });
  const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
  const error = { description: 'API error', content: { 'application/json': { schema: ref('ErrorResponse') } } };
  const response = (schema) => ({ 200: json(ref(schema)), 400: error, 403: error, 502: error, 503: error, 504: error });
  const buildResponse = (schema, status = 200) => ({ [status]: json(ref(schema)), 403: error, 503: error });
  const buildSecuritySummary = 'Always requires internal token. If ROUTING_INTERNAL_TOKEN is missing, build endpoints are disabled or server startup fails depending on config.';
  const limitsDescription = [
    'Runtime limits and routing flags:',
    'MAX_ROUTE_LOCATIONS, MAX_MATRIX_SOURCES, MAX_MATRIX_TARGETS, MAX_MATRIX_CELLS,',
    'MAX_SNAP_LOCATIONS, DEFAULT_SNAP_RADIUS_METERS, MAX_SNAP_RADIUS_METERS,',
    'MAX_MAP_MATCH_POINTS, MAX_OPTIMIZATION_JOBS, VALHALLA_TIMEOUT_MS,',
    'ROUTING_INCLUDE_RAW, ROUTING_ALLOW_REQUEST_RAW, ROUTING_INTERNAL_TOKEN.',
    'Raw upstream Valhalla payloads are excluded by default.'
  ].join(' ');

  const directionsQuery = [
    { name: 'units', schema: { type: 'string', enum: ['kilometers', 'miles'], default: 'kilometers' } },
    { name: 'engine', schema: { type: 'string', enum: ['auto', 'regional', 'world'], default: 'auto' } },
    { name: 'area', schema: { type: 'string', example: areaExample } },
    { name: 'alternatives', schema: { type: 'boolean', default: false } },
    { name: 'max_alternatives', schema: { type: 'integer', minimum: 1, maximum: 2, default: 1 } },
    { name: 'steps', schema: { type: 'boolean', default: true } },
    { name: 'language', schema: { type: 'string', example: 'ar' } },
    { name: 'shape_format', schema: { type: 'string', enum: ['polyline6', 'polyline', 'geojson'], default: 'polyline6' } },
    { name: 'overview', schema: { type: 'string', enum: ['full', 'false'], default: 'full' } },
    { name: 'annotations', schema: { type: 'string', example: 'duration' }, description: 'Reserved for compatibility. Currently rejected because Valhalla does not provide trustworthy Mapbox-style annotation arrays through this proxy.' },
    { name: 'avoid_tolls', schema: { type: 'boolean' } },
    { name: 'avoid_highways', schema: { type: 'boolean' } },
    { name: 'avoid_ferries', schema: { type: 'boolean' } },
    { name: 'avoid_unpaved', schema: { type: 'boolean' } },
    { name: 'voice_instructions', schema: { type: 'boolean' } },
    { name: 'banner_instructions', schema: { type: 'boolean' } },
    { name: 'depart_at', schema: { type: 'string', format: 'date-time' } },
    { name: 'arrive_by', schema: { type: 'string', format: 'date-time' } },
    { name: 'include_raw', schema: { type: 'boolean', default: false }, description: 'Only honored when ROUTING_ALLOW_REQUEST_RAW=true.' }
  ].map((param) => ({ in: 'query', required: false, ...param }));

  const post = (tag, summary, requestSchema, responseSchema, example) => ({
    post: {
      tags: [tag],
      summary,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: ref(requestSchema), example } }
      },
      responses: response(responseSchema)
    }
  });

  return {
    openapi: '3.0.3',
    info: {
      title: 'Tavrix Valhalla Routing API',
      version: '1.2.0',
      description: `Internal routing engine proxy for Valhalla with regional/world selection, important areas, request IDs, metrics, and normalized responses. ${limitsDescription}`
    },
    servers: [{ url: `http://localhost:${port}`, description: 'Local routing API' }],
    tags: ['Directions', 'Routing', 'Matrix', 'Isochrone', 'Map Matching', 'Snap', 'Optimization', 'Areas', 'Health', 'Builds', 'Metrics'].map((name) => ({ name })),
    paths: {
      '/api/routing/directions/{costing}/{coordinates}': {
        get: {
          tags: ['Directions'],
          summary: 'Mapbox-like GET directions endpoint',
          parameters: [
            { name: 'costing', in: 'path', required: true, schema: ref('Costing') },
            { name: 'coordinates', in: 'path', required: true, schema: { type: 'string', example: '50.5876,26.2235;50.5860,26.2285' } },
            ...directionsQuery
          ],
          responses: response('RouteResponse')
        }
      },
      '/api/routing/route': post('Routing', 'Calculate a rich route', 'RouteRequest', 'RouteResponse', { locations: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }], costing: 'auto', area: areaExample, steps: true }),
      '/api/routing/matrix': post('Matrix', 'Calculate many-to-many ETA and distance', 'MatrixRequest', 'MatrixResponse', { sources: [{ lat: 26.2235, lon: 50.5876 }], targets: [{ lat: 26.2285, lon: 50.5860 }], costing: 'auto', area: areaExample }),
      '/api/routing/isochrone': post('Isochrone', 'Calculate reachable area', 'IsochroneRequest', 'IsochroneResponse', { locations: [{ lat: 26.2235, lon: 50.5876 }], contours: [{ time: 10 }], costing: 'auto', area: areaExample }),
      '/api/routing/map-match': post('Map Matching', 'Match GPS trace to roads', 'MapMatchRequest', 'MapMatchResponse', { shape: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }], costing: 'auto', area: areaExample }),
      '/api/routing/snap': post('Snap', 'Snap coordinates to the road network', 'SnapRequest', 'SnapResponse', { locations: [{ lat: 26.2235, lon: 50.5876 }], costing: 'auto', radius: 50, area: areaExample }),
      '/api/routing/nearest': post('Snap', 'Return nearest road metadata', 'SnapRequest', 'SnapResponse', { locations: [{ lat: 26.2235, lon: 50.5876 }], costing: 'auto', radius: 50, area: areaExample }),
      '/api/routing/distance': post('Routing', 'Return haversine and routed distance', 'DistanceRequest', 'DistanceResponse', { from: { lat: 26.2235, lon: 50.5876 }, to: { lat: 26.2285, lon: 50.5860 }, costing: 'auto', area: areaExample }),
      '/api/routing/optimization': post('Optimization', 'Heuristic route optimization', 'OptimizationRequest', 'OptimizationResponse', { start: { lat: 26.2235, lon: 50.5876 }, jobs: [{ id: 'order_1', lat: 26.2285, lon: 50.5860, service_seconds: 300 }], end: { lat: 26.2235, lon: 50.5876 }, costing: 'auto', area: areaExample }),
      '/api/routing/areas': { get: { tags: ['Areas'], summary: 'List important areas', responses: { 200: json(ref('AreasResponse')) } } },
      '/api/routing/areas/{area_id}': areaGet('AreaResponse', areaExample),
      '/api/routing/areas/{area_id}/health': areaGet('AreaHealthResponse', areaExample),
      '/api/routing/areas/{area_id}/coverage': areaGet('AreaCoverageResponse', areaExample),
      '/api/routing/areas/{area_id}/builds': areaGet('AreaBuildsResponse', areaExample),
      '/api/routing/health': { get: { tags: ['Health'], summary: 'Full health', responses: { 200: json(ref('HealthResponse')), 503: error } } },
      '/api/routing/health/live': { get: { tags: ['Health'], summary: 'Liveness probe', responses: { 200: json(ref('LiveResponse')) } } },
      '/api/routing/health/ready': { get: { tags: ['Health'], summary: 'Readiness probe', responses: { 200: json(ref('ReadyResponse')), 503: error } } },
      '/api/routing/health/dependencies': { get: { tags: ['Health'], summary: 'Dependency health', responses: { 200: json(ref('DependenciesResponse')) } } },
      '/api/routing/builds': { get: { tags: ['Builds'], summary: `List builds. ${buildSecuritySummary}`, description: buildSecuritySummary, security: internalSecurity(), responses: buildResponse('BuildsResponse') } },
      '/api/routing/builds/current': { get: { tags: ['Builds'], summary: `Current build metadata. ${buildSecuritySummary}`, description: buildSecuritySummary, security: internalSecurity(), responses: buildResponse('CurrentBuildResponse') } },
      '/api/routing/builds/{build_id}/activate': { post: { tags: ['Builds'], summary: `Return safe activation command. ${buildSecuritySummary}`, description: buildSecuritySummary, security: internalSecurity(), parameters: [{ name: 'build_id', in: 'path', required: true, schema: { type: 'string' } }], responses: buildResponse('BuildActionResponse', 202) } },
      '/api/routing/reload': { post: { tags: ['Builds'], summary: `Return safe reload command. ${buildSecuritySummary}`, description: buildSecuritySummary, security: internalSecurity(), responses: buildResponse('BuildActionResponse', 202) } },
      '/metrics': { get: { tags: ['Metrics'], summary: 'Prometheus metrics', responses: { 200: { description: 'Prometheus text format', content: { 'text/plain': { schema: { type: 'string' } } } } } } }
    },
    components: {
      securitySchemes: {
        internalToken: {
          type: 'apiKey',
          in: 'header',
          name: 'x-internal-token'
        },
        bearerInternalToken: {
          type: 'http',
          scheme: 'bearer'
        }
      },
      responses: {
        Error: { description: 'API error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
      },
      schemas: schemas(areaExample)
    },
    'x-tavrix': { regional_url: regionalUrl, world_url: worldUrl || null, important_areas: importantAreas }
  };
}

function internalSecurity() {
  return [{ internalToken: [] }, { bearerInternalToken: [] }];
}

function areaGet(schema, example) {
  return {
    get: {
      tags: ['Areas'],
      parameters: [{ name: 'area_id', in: 'path', required: true, schema: { type: 'string', example } }],
      responses: { 200: { description: 'Success', content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } } }, 404: { $ref: '#/components/responses/Error' } }
    }
  };
}

function schemas(areaExample) {
  const coordinate = {
    type: 'object',
    required: ['lat', 'lon'],
    properties: {
      lat: { type: 'number', minimum: -90, maximum: 90, example: 26.2235 },
      lon: { type: 'number', minimum: -180, maximum: 180, example: 50.5876 }
    }
  };
  const warning = { type: 'array', items: { type: 'string' } };
  const engine = { type: 'string', enum: ['regional', 'world'], example: 'regional' };
  const graphVersion = { type: 'string', nullable: true, description: 'Validated active graph build identifier.' };
  const rawDescription = 'Returned only when ROUTING_INCLUDE_RAW=true, or when include_raw=true is allowed by ROUTING_ALLOW_REQUEST_RAW=true. Excluded by default.';
  const area = { type: 'string', example: areaExample, description: 'Optional configured important area id. When omitted, the API auto-selects a configured area by coordinate bounds when possible.' };
  const routeOptions = {
    costing: { $ref: '#/components/schemas/Costing' },
    units: { type: 'string', enum: ['kilometers', 'miles'], default: 'kilometers', description: 'Distance units. Defaults to kilometers.' },
    engine: { type: 'string', enum: ['auto', 'regional', 'world'], default: 'auto', description: 'Routing engine selector. Defaults to auto, which prefers a configured important area/regional graph when coordinates fit.' },
    area,
    alternatives: { type: 'boolean' },
    max_alternatives: { type: 'integer', minimum: 1, maximum: 2 },
    steps: { type: 'boolean', default: false, description: 'Include maneuver steps. Defaults to false for POST route requests.' },
    language: { type: 'string' },
    shape_format: { type: 'string', enum: ['polyline6', 'polyline', 'geojson'], default: 'polyline6', description: 'Returned geometry format. Defaults to polyline6.' },
    overview: { type: 'string', enum: ['full', 'false'], default: 'full', description: 'Route overview geometry detail. simplified is intentionally rejected until simplification is implemented.' },
    annotations: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Reserved compatibility field. Non-empty annotations are rejected until trustworthy annotation arrays are implemented.' },
    avoid_tolls: { type: 'boolean' },
    avoid_highways: { type: 'boolean' },
    avoid_ferries: { type: 'boolean' },
    avoid_unpaved: { type: 'boolean' },
    voice_instructions: { type: 'boolean' },
    banner_instructions: { type: 'boolean' },
    depart_at: { type: 'string', format: 'date-time' },
    arrive_by: { type: 'string', format: 'date-time' },
    truck: { $ref: '#/components/schemas/TruckOptions' }
  };

  return {
    Coordinate: coordinate,
    Costing: { type: 'string', enum: ['auto', 'pedestrian', 'bicycle', 'motor_scooter', 'motorcycle', 'truck', 'bus', 'taxi'], default: 'auto' },
    TruckOptions: { type: 'object', properties: { height: { type: 'number' }, width: { type: 'number' }, length: { type: 'number' }, weight: { type: 'number' }, hazmat: { type: 'boolean' } } },
    RouteRequest: { type: 'object', required: ['locations'], properties: { locations: { type: 'array', minItems: 2, items: coordinate }, ...routeOptions } },
    MatrixRequest: { type: 'object', oneOf: [{ required: ['locations'] }, { required: ['sources', 'targets'] }], properties: { sources: { type: 'array', items: coordinate }, targets: { type: 'array', items: coordinate }, locations: { type: 'array', items: coordinate }, costing: routeOptions.costing, engine: routeOptions.engine, area } },
    IsochroneRequest: { type: 'object', required: ['locations', 'contours'], properties: { locations: { type: 'array', minItems: 1, items: coordinate }, contours: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, distance: { type: 'number' } } } }, costing: routeOptions.costing, engine: routeOptions.engine, area, polygons: { type: 'boolean', default: true } } },
    MapMatchRequest: { type: 'object', oneOf: [{ required: ['shape'] }, { required: ['locations'] }], properties: { shape: { type: 'array', items: coordinate }, locations: { type: 'array', items: coordinate }, costing: routeOptions.costing, units: routeOptions.units, engine: routeOptions.engine, area, shape_match: { type: 'string', enum: ['map_snap', 'walk_or_snap'], default: 'map_snap' }, steps: { type: 'boolean', default: true }, shape_format: routeOptions.shape_format } },
    SnapRequest: { type: 'object', required: ['locations'], properties: { locations: { type: 'array', items: coordinate }, costing: routeOptions.costing, radius: { type: 'number', description: 'Snap search radius in meters. Defaults to DEFAULT_SNAP_RADIUS_METERS.' }, engine: routeOptions.engine, area } },
    DistanceRequest: { type: 'object', required: ['from', 'to'], properties: { from: coordinate, to: coordinate, costing: routeOptions.costing, engine: routeOptions.engine, area } },
    OptimizationRequest: { type: 'object', required: ['start', 'jobs'], properties: { start: coordinate, jobs: { type: 'array', items: { type: 'object', required: ['id', 'lat', 'lon'], properties: { id: { type: 'string' }, lat: { type: 'number', minimum: -90, maximum: 90 }, lon: { type: 'number', minimum: -180, maximum: 180 }, service_seconds: { type: 'number', minimum: 0 } } } }, end: coordinate, costing: routeOptions.costing, engine: routeOptions.engine, area } },
    Geometry: {
      nullable: true,
      oneOf: [
        { type: 'string', description: 'Encoded polyline or polyline6 geometry.' },
        { $ref: '#/components/schemas/GeoJsonLineString' }
      ]
    },
    Bounds: {
      type: 'object',
      required: ['minLon', 'minLat', 'maxLon', 'maxLat'],
      properties: {
        minLon: { type: 'number' },
        minLat: { type: 'number' },
        maxLon: { type: 'number' },
        maxLat: { type: 'number' }
      }
    },
    GeoJsonLineString: {
      type: 'object',
      required: ['type', 'coordinates'],
      properties: {
        type: { type: 'string', enum: ['LineString'] },
        coordinates: { type: 'array', items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } } }
      }
    },
    Maneuver: {
      type: 'object',
      required: ['type', 'modifier', 'location'],
      properties: {
        type: { type: 'string', enum: ['turn', 'depart', 'arrive', 'merge', 'roundabout', 'continue', 'fork', 'end of road'] },
        modifier: { type: 'string', enum: ['left', 'right', 'straight', 'slight left', 'slight right', 'sharp left', 'sharp right', 'uturn'] },
        location: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
        bearing_before: { type: 'number', nullable: true },
        bearing_after: { type: 'number', nullable: true }
      }
    },
    Step: { type: 'object', required: ['instruction', 'name', 'distance', 'duration', 'maneuver'], properties: { instruction: { type: 'string' }, name: { type: 'string' }, distance: { type: 'number' }, duration: { type: 'number' }, maneuver: { $ref: '#/components/schemas/Maneuver' } } },
    Route: { type: 'object', required: ['distance', 'duration', 'geometry', 'legs'], properties: { distance: { type: 'number' }, duration: { type: 'number' }, geometry: { $ref: '#/components/schemas/Geometry' }, legs: { type: 'array', items: { type: 'object', required: ['distance', 'duration', 'summary', 'steps'], properties: { distance: { type: 'number' }, duration: { type: 'number' }, summary: { type: 'string' }, steps: { type: 'array', items: { $ref: '#/components/schemas/Step' } } } } } } },
    RouteResponse: { type: 'object', required: ['distance', 'duration', 'units', 'geometry', 'routes', 'engine', 'area', 'graph_version', 'warnings'], properties: { distance: { type: 'number' }, duration: { type: 'number' }, units: { type: 'string' }, geometry: { $ref: '#/components/schemas/Geometry' }, routes: { type: 'array', items: { $ref: '#/components/schemas/Route' } }, engine, area, graph_version: graphVersion, warnings: warning, raw: { type: 'object', description: rawDescription } } },
    MatrixResponse: { type: 'object', required: ['sources_count', 'targets_count', 'cells', 'durations', 'distances', 'engine', 'area', 'graph_version', 'warnings'], properties: { sources_count: { type: 'integer' }, targets_count: { type: 'integer' }, cells: { type: 'integer' }, durations: { type: 'array', items: { type: 'array', items: { type: 'number', nullable: true } } }, distances: { type: 'array', items: { type: 'array', items: { type: 'number', nullable: true } } }, engine, area, graph_version: graphVersion, warnings: warning, raw: { type: 'object', description: rawDescription } } },
    IsochroneResponse: { type: 'object', required: ['type', 'features', 'engine', 'area', 'graph_version', 'warnings'], additionalProperties: true, properties: { type: { type: 'string', enum: ['FeatureCollection'] }, features: { type: 'array', items: { type: 'object' } }, engine, area, graph_version: graphVersion, warnings: warning } },
    MapMatchResponse: { type: 'object', required: ['confidence', 'matched_points', 'unmatched_points', 'snapped_distance_m', 'quality_status', 'geometry', 'routes', 'engine', 'area', 'graph_version', 'warnings'], properties: { confidence: { type: 'number', nullable: true }, matched_points: { type: 'integer', nullable: true }, unmatched_points: { type: 'integer', nullable: true }, snapped_distance_m: { type: 'number', nullable: true }, quality_status: { type: 'string' }, geometry: { $ref: '#/components/schemas/Geometry' }, routes: { type: 'array', items: { $ref: '#/components/schemas/Route' } }, engine, area, graph_version: { type: 'string', nullable: true }, warnings: warning, raw: { type: 'object', description: rawDescription } } },
    SnapResult: { type: 'object', required: ['input', 'matched', 'snapped', 'distance_meters', 'edge_id', 'road_name', 'road_class', 'speed', 'maxspeed', 'graph_version'], properties: { input: coordinate, matched: { type: 'boolean' }, snapped: { ...coordinate, nullable: true }, distance_meters: { type: 'number', nullable: true }, edge_id: { type: 'string', nullable: true }, road_name: { type: 'string' }, road_class: { type: 'string', nullable: true }, speed: { type: 'number', nullable: true }, maxspeed: { type: 'number', nullable: true }, side_of_street: { type: 'string', nullable: true }, graph_version: graphVersion, reason: { type: 'string', enum: ['no_edge_found', 'outside_radius'], nullable: true } } },
    SnapResponse: { type: 'object', required: ['results', 'engine', 'area', 'graph_version', 'warnings'], properties: { results: { type: 'array', items: { $ref: '#/components/schemas/SnapResult' } }, engine, area, graph_version: graphVersion, warnings: warning } },
    DistanceResponse: { type: 'object', required: ['haversine_distance_m', 'route_distance_m', 'duration_s', 'engine', 'area', 'graph_version', 'warnings'], properties: { haversine_distance_m: { type: 'number' }, route_distance_m: { type: 'number' }, duration_s: { type: 'number' }, engine, area, graph_version: graphVersion, warnings: warning } },
    OptimizationResponse: { type: 'object', required: ['ordered_jobs', 'route', 'total_distance_m', 'total_duration_s', 'optimizer', 'optimal', 'engine', 'area', 'graph_version', 'warnings'], properties: { ordered_jobs: { type: 'array' }, route: { $ref: '#/components/schemas/RouteResponse' }, total_distance_m: { type: 'number' }, total_duration_s: { type: 'number' }, optimizer: { type: 'string', example: 'nearest_neighbor' }, optimal: { type: 'boolean', example: false }, engine, area, graph_version: graphVersion, warnings: warning } },
    ImportantArea: { type: 'object', required: ['id', 'label', 'bounds'], properties: { id: { type: 'string' }, label: { type: 'string' }, bounds: { $ref: '#/components/schemas/Bounds' } } },
    AreasResponse: { type: 'object', required: ['areas'], properties: { areas: { type: 'array', items: { $ref: '#/components/schemas/ImportantArea' } } } },
    AreaResponse: { type: 'object', required: ['area', 'enabled_profiles', 'engine'], properties: { area: { $ref: '#/components/schemas/ImportantArea' }, enabled_profiles: { type: 'array', items: { type: 'string' } }, engine: { type: 'string' } } },
    AreaHealthResponse: { type: 'object', required: ['area', 'ok', 'active_color', 'active_build', 'graph_path', 'config_path', 'checks', 'graph_file_count', 'regional'], properties: { area: { type: 'string' }, ok: { type: 'boolean' }, active_color: { type: 'string', enum: ['blue', 'green'] }, active_build: graphVersion, graph_path: { type: 'string' }, config_path: { type: 'string' }, checks: { type: 'object' }, graph_file_count: { type: 'integer' }, regional: { $ref: '#/components/schemas/DependencyStatus' } } },
    AreaCoverageResponse: { type: 'object', required: ['area', 'bounds', 'graph_path', 'build_id', 'active_color', 'enabled_profiles', 'min_lat', 'max_lat', 'min_lon', 'max_lon'], properties: { area: { type: 'string' }, bounds: { $ref: '#/components/schemas/Bounds' }, graph_path: { type: 'string' }, build_id: graphVersion, active_color: { type: 'string', enum: ['blue', 'green'] }, enabled_profiles: { type: 'array', items: { type: 'string' } }, min_lat: { type: 'number' }, max_lat: { type: 'number' }, min_lon: { type: 'number' }, max_lon: { type: 'number' } } },
    AreaBuildsResponse: { type: 'object', required: ['area', 'builds'], properties: { area: { type: 'string' }, builds: { type: 'array', items: { type: 'string' } } } },
    DependencyStatus: { type: 'object', required: ['ok', 'url', 'latency_ms', 'error'], properties: { ok: { type: 'boolean' }, url: { type: 'string', nullable: true }, latency_ms: { type: 'number' }, error: { type: 'string', nullable: true } } },
    HealthResponse: { type: 'object', required: ['status', 'service', 'mode', 'region', 'active_build', 'active_color', 'checks', 'engines'], properties: { status: { type: 'string' }, service: { type: 'string' }, mode: { type: 'string' }, region: { type: 'string' }, active_build: graphVersion, active_color: { type: 'string', enum: ['blue', 'green'] }, checks: { type: 'object' }, engines: { type: 'object', required: ['regional', 'world'], properties: { regional: { allOf: [{ $ref: '#/components/schemas/DependencyStatus' }] }, world: { allOf: [{ $ref: '#/components/schemas/DependencyStatus' }] } } } } },
    LiveResponse: { type: 'object', required: ['status'], properties: { status: { type: 'string', example: 'ok' } } },
    ReadyResponse: { type: 'object', required: ['status', 'ok', 'regional', 'active_color', 'active_build', 'graph_path', 'config_path', 'checks', 'areas_count'], properties: { status: { type: 'string' }, ok: { type: 'boolean' }, regional: { $ref: '#/components/schemas/DependencyStatus' }, active_color: { type: 'string', enum: ['blue', 'green'] }, active_build: { type: 'string', nullable: true }, graph_path: { type: 'string' }, config_path: { type: 'string' }, checks: { type: 'object' }, areas_count: { type: 'integer' } } },
    DependenciesResponse: { type: 'object', required: ['regional', 'world', 'active_color', 'graph_version'], properties: { regional: { $ref: '#/components/schemas/DependencyStatus' }, world: { $ref: '#/components/schemas/DependencyStatus' }, active_color: { type: 'string', enum: ['blue', 'green'] }, graph_version: graphVersion } },
    BuildsResponse: { type: 'object', required: ['builds'], properties: { builds: { type: 'array', items: { type: 'string' } } } },
    CurrentBuildResponse: { type: 'object', required: ['active_version', 'manifest'], properties: { active_version: { type: 'object' }, manifest: { type: 'object', nullable: true } } },
    BuildActionResponse: { type: 'object', required: ['status', 'command'], properties: { status: { type: 'string' }, build_id: { type: 'string' }, command: { type: 'string' } } },
    ErrorResponse: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['status', 'code', 'message', 'request_id'], properties: { status: { type: 'integer' }, code: { type: 'string' }, message: { type: 'string' }, request_id: { type: 'string' }, details: { type: 'object' } } } } }
  };
}
