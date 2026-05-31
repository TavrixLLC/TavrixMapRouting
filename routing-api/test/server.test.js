import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.VALHALLA_IMPORTANT_AREAS = 'bahrain|Bahrain|50.2,25.5,51.0,26.6';
process.env.VALHALLA_TIMEOUT_MS = '10';
process.env.MAX_MATRIX_CELLS = '4';
process.env.MAX_SNAP_RADIUS_METERS = '100';
process.env.MAX_MAP_MATCH_POINTS = '3';
process.env.MAX_OPTIMIZATION_JOBS = '2';
process.env.ROUTING_ALLOW_REQUEST_RAW = 'true';

const { app } = await import('../src/server.js');

function request(server, method, path, body, headers = {}) {
  const address = server.address();
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers }
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function mockFetch(handler) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => handler(String(url), options);
  return () => { globalThis.fetch = previous; };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function withServer(fn) {
  const server = app.listen(0);
  try {
    await fn(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const routePayload = {
  trip: {
    units: 'kilometers',
    summary: { length: 1.2, time: 120 },
    legs: [
      {
        shape: 'qwp_q@ozrn_BeBaA',
        summary: { length: 1.2, time: 120 },
        maneuvers: [
          { instruction: 'Head north', street_names: ['Road 1'], length: 1.2, time: 120, type: 1, begin_shape_index: 0, begin_heading: 5, end_heading: 20 }
        ]
      }
    ]
  }
};

test('GET directions returns rich route response', async () => {
  const restore = mockFetch((url) => {
    assert.match(url, /\/route$/);
    return jsonResponse(routePayload);
  });
  await withServer(async (server) => {
    const res = await request(server, 'GET', '/api/routing/directions/auto/50.5876,26.2235;50.5860,26.2285?steps=true&area=bahrain');
    assert.equal(res.status, 200);
    assert.equal(res.body.distance, 1.2);
    assert.equal(res.body.routes[0].legs[0].steps[0].instruction, 'Head north');
    assert.equal(res.body.engine, 'regional');
  });
  restore();
});

test('geometry defaults to encoded polyline string and maps maneuver schema', async () => {
  const restore = mockFetch(() => jsonResponse(routePayload));
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/api/routing/route', {
      locations: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }],
      area: 'bahrain',
      steps: true
    });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.geometry, 'string');
    const maneuver = res.body.routes[0].legs[0].steps[0].maneuver;
    assert.equal(maneuver.type, 'depart');
    assert.equal(maneuver.modifier, 'straight');
    assert.deepEqual(maneuver.location.length, 2);
    assert.equal(maneuver.bearing_before, 5);
    assert.equal(maneuver.bearing_after, 20);
  });
  restore();
});

test('geometry can be returned as GeoJSON LineString', async () => {
  const restore = mockFetch(() => jsonResponse(routePayload));
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/api/routing/route', {
      locations: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }],
      area: 'bahrain',
      shape_format: 'geojson'
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.geometry.type, 'LineString');
    assert.ok(Array.isArray(res.body.geometry.coordinates));
  });
  restore();
});

test('raw is excluded by default and included by allowed request flag', async () => {
  const restore = mockFetch(() => jsonResponse(routePayload));
  await withServer(async (server) => {
    process.env.ROUTING_INCLUDE_RAW = 'false';
    process.env.ROUTING_ALLOW_REQUEST_RAW = 'false';
    const excluded = await request(server, 'POST', '/api/routing/route', {
      locations: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }],
      area: 'bahrain'
    });
    assert.equal(excluded.status, 200);
    assert.equal('raw' in excluded.body, false);
    const ignored = await request(server, 'POST', '/api/routing/route', {
      locations: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }],
      area: 'bahrain',
      include_raw: true
    });
    assert.equal(ignored.status, 200);
    assert.equal('raw' in ignored.body, false);
    process.env.ROUTING_ALLOW_REQUEST_RAW = 'true';
    const included = await request(server, 'POST', '/api/routing/route', {
      locations: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }],
      area: 'bahrain',
      include_raw: true
    });
    assert.equal(included.status, 200);
    assert.equal(included.body.raw.trip.summary.length, 1.2);
    process.env.ROUTING_INCLUDE_RAW = 'true';
    const globallyIncluded = await request(server, 'POST', '/api/routing/route', {
      locations: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }],
      area: 'bahrain'
    });
    assert.equal(globallyIncluded.status, 200);
    assert.equal(globallyIncluded.body.raw.trip.summary.length, 1.2);
    process.env.ROUTING_INCLUDE_RAW = 'false';
    process.env.ROUTING_ALLOW_REQUEST_RAW = 'false';
  });
  restore();
});

test('OpenAPI exposes reusable schemas, defaults, required fields, and request contracts', async () => {
  await withServer(async (server) => {
    const res = await request(server, 'GET', '/api/routing/openapi.json');
    assert.equal(res.status, 200);
    assert.equal(res.body.openapi, '3.0.3');
    assert.ok(res.body.info.description.includes('MAX_ROUTE_LOCATIONS'));
    assert.deepEqual(res.body.components.schemas.Bounds.required, ['minLon', 'minLat', 'maxLon', 'maxLat']);
    assert.deepEqual(res.body.components.schemas.DependencyStatus.required, ['ok', 'url', 'latency_ms', 'error']);
    assert.equal(res.body.components.schemas.ImportantArea.properties.bounds.$ref, '#/components/schemas/Bounds');
    assert.deepEqual(res.body.components.schemas.MatrixRequest.oneOf, [{ required: ['locations'] }, { required: ['sources', 'targets'] }]);
    assert.deepEqual(res.body.components.schemas.MapMatchRequest.oneOf, [{ required: ['shape'] }, { required: ['locations'] }]);
    assert.equal(res.body.components.schemas.Costing.default, 'auto');
    assert.equal(res.body.components.schemas.RouteRequest.properties.units.default, 'kilometers');
    assert.equal(res.body.components.schemas.RouteRequest.properties.engine.default, 'auto');
    assert.equal(res.body.components.schemas.RouteRequest.properties.steps.default, false);
    assert.equal(res.body.components.schemas.RouteRequest.properties.shape_format.default, 'polyline6');
    assert.equal(res.body.components.schemas.RouteRequest.properties.overview.default, 'full');
    assert.ok(res.body.components.schemas.RouteResponse.properties.raw.description.includes('Excluded by default'));
    for (const schemaName of [
      'AreasResponse',
      'AreaResponse',
      'AreaHealthResponse',
      'AreaCoverageResponse',
      'AreaBuildsResponse',
      'HealthResponse',
      'LiveResponse',
      'ReadyResponse',
      'DependenciesResponse',
      'BuildsResponse',
      'CurrentBuildResponse',
      'BuildActionResponse'
    ]) {
      assert.ok(Array.isArray(res.body.components.schemas[schemaName].required), `${schemaName} has required fields`);
      assert.ok(res.body.components.schemas[schemaName].required.length > 0, `${schemaName} required is non-empty`);
    }
  });
});

test('dependency health returns DependencyStatus shape', async () => {
  const restore = mockFetch(() => jsonResponse({ ok: true }));
  await withServer(async (server) => {
    const res = await request(server, 'GET', '/api/routing/health/dependencies');
    assert.equal(res.status, 200);
    for (const field of ['ok', 'url', 'latency_ms', 'error']) {
      assert.ok(field in res.body.regional);
      assert.ok(field in res.body.world);
    }
  });
  restore();
});

test('POST route maps truck options and alternatives', async () => {
  let upstreamBody = null;
  const restore = mockFetch((_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return jsonResponse(routePayload);
  });
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/api/routing/route', {
      locations: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }],
      costing: 'truck',
      area: 'bahrain',
      alternatives: true,
      max_alternatives: 2,
      truck: { height: 4.2, width: 2.5, length: 12, weight: 18000, hazmat: false }
    });
    assert.equal(res.status, 200);
    assert.equal(upstreamBody.alternates, 2);
    assert.equal(upstreamBody.costing_options.truck.height, 4.2);
  });
  restore();
});

test('invalid coordinate returns consistent error', async () => {
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/api/routing/route', {
      locations: [{ lat: 260, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }]
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_coordinate');
  });
});

test('matrix response includes cells and counts', async () => {
  const restore = mockFetch(() => jsonResponse({ sources_to_targets: [[{ time: 10, distance: 0.5 }]] }));
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/api/routing/matrix', {
      sources: [{ lat: 26.2235, lon: 50.5876 }],
      targets: [{ lat: 26.2285, lon: 50.5860 }],
      area: 'bahrain'
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.sources_count, 1);
    assert.equal(res.body.cells, 1);
  });
  restore();
});

test('matrix rejects empty body and accepts locations shorthand', async () => {
  const restore = mockFetch(() => jsonResponse({
    sources_to_targets: [
      [{ time: 0, distance: 0 }, { time: 10, distance: 0.5 }],
      [{ time: 10, distance: 0.5 }, { time: 0, distance: 0 }]
    ]
  }));
  await withServer(async (server) => {
    const rejected = await request(server, 'POST', '/api/routing/matrix', {});
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /locations or sources and targets/);
    const accepted = await request(server, 'POST', '/api/routing/matrix', {
      locations: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }],
      area: 'bahrain'
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.sources_count, 2);
    assert.equal(accepted.body.targets_count, 2);
    assert.equal(accepted.body.cells, 4);
  });
  restore();
});

test('matrix accepts sources plus targets contract', async () => {
  const restore = mockFetch(() => jsonResponse({ sources_to_targets: [[{ time: 10, distance: 0.5 }]] }));
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/api/routing/matrix', {
      sources: [{ lat: 26.2235, lon: 50.5876 }],
      targets: [{ lat: 26.2285, lon: 50.5860 }],
      area: 'bahrain'
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.sources_count, 1);
    assert.equal(res.body.targets_count, 1);
  });
  restore();
});

test('Valhalla unavailable returns 502', async () => {
  const restore = mockFetch(() => { throw new Error('offline'); });
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/api/routing/route', {
      locations: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }],
      area: 'bahrain'
    });
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'upstream_unavailable');
  });
  restore();
});

test('invalid directions coordinates path returns invalid_coordinate', async () => {
  await withServer(async (server) => {
    const res = await request(server, 'GET', '/api/routing/directions/auto/not-a-coordinate');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_coordinate');
  });
});

test('boolean query parsing and max_alternatives validation are strict', async () => {
  await withServer(async (server) => {
    const badBool = await request(server, 'GET', '/api/routing/directions/auto/50.5876,26.2235;50.5860,26.2285?alternatives=maybe');
    assert.equal(badBool.status, 400);
    const badAlt = await request(server, 'GET', '/api/routing/directions/auto/50.5876,26.2235;50.5860,26.2285?max_alternatives=9');
    assert.equal(badAlt.status, 400);
  });
});

test('depart_at and arrive_by validation rejects invalid or conflicting values', async () => {
  await withServer(async (server) => {
    const invalid = await request(server, 'GET', '/api/routing/directions/auto/50.5876,26.2235;50.5860,26.2285?depart_at=nope');
    assert.equal(invalid.status, 400);
    const conflict = await request(server, 'GET', '/api/routing/directions/auto/50.5876,26.2235;50.5860,26.2285?depart_at=2026-05-30T10:00:00Z&arrive_by=2026-05-30T11:00:00Z');
    assert.equal(conflict.status, 400);
  });
});

test('area runtime validation rejects unknown areas', async () => {
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/api/routing/route', {
      locations: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }],
      area: 'unknown'
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_request');
  });
});

test('matrix max cells exceeded is rejected', async () => {
  await withServer(async (server) => {
    const points = [
      { lat: 26.2235, lon: 50.5876 },
      { lat: 26.2285, lon: 50.5860 },
      { lat: 26.229, lon: 50.588 }
    ];
    const res = await request(server, 'POST', '/api/routing/matrix', { sources: points, targets: points, area: 'bahrain' });
    assert.equal(res.status, 400);
  });
});

test('snap radius limit is enforced', async () => {
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/api/routing/snap', {
      locations: [{ lat: 26.2235, lon: 50.5876 }],
      radius: 1000,
      area: 'bahrain'
    });
    assert.equal(res.status, 400);
  });
});

test('map-match max points is enforced', async () => {
  await withServer(async (server) => {
    const shape = [
      { lat: 26.2235, lon: 50.5876 },
      { lat: 26.2285, lon: 50.5860 },
      { lat: 26.229, lon: 50.588 },
      { lat: 26.23, lon: 50.589 }
    ];
    const res = await request(server, 'POST', '/api/routing/map-match', { shape, area: 'bahrain' });
    assert.equal(res.status, 400);
  });
});

test('map-match rejects empty body and accepts shape or locations', async () => {
  const restore = mockFetch(() => jsonResponse(routePayload));
  await withServer(async (server) => {
    const rejected = await request(server, 'POST', '/api/routing/map-match', {});
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /shape or locations/);
    const shape = await request(server, 'POST', '/api/routing/map-match', {
      shape: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }],
      area: 'bahrain'
    });
    assert.equal(shape.status, 200);
    assert.equal(shape.body.matched_points, 2);
    const locations = await request(server, 'POST', '/api/routing/map-match', {
      locations: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }],
      area: 'bahrain'
    });
    assert.equal(locations.status, 200);
    assert.equal(locations.body.matched_points, 2);
  });
  restore();
});

test('optimization max jobs is enforced', async () => {
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/api/routing/optimization', {
      start: { lat: 26.2235, lon: 50.5876 },
      jobs: [
        { id: '1', lat: 26.2285, lon: 50.5860 },
        { id: '2', lat: 26.229, lon: 50.588 },
        { id: '3', lat: 26.23, lon: 50.589 }
      ],
      area: 'bahrain'
    });
    assert.equal(res.status, 400);
  });
});

test('build endpoints require token configuration', async () => {
  await withServer(async (server) => {
    const res = await request(server, 'GET', '/api/routing/builds');
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'internal_token_missing');
  });
});

test('isochrone response has FeatureCollection shape', async () => {
  const restore = mockFetch(() => jsonResponse({ type: 'FeatureCollection', features: [] }));
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/api/routing/isochrone', {
      locations: [{ lat: 26.2235, lon: 50.5876 }],
      contours: [{ time: 10 }],
      area: 'bahrain'
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.type, 'FeatureCollection');
    assert.ok(Array.isArray(res.body.features));
    assert.ok(Array.isArray(res.body.warnings));
  });
  restore();
});

test('common response required fields exist', async () => {
  const restore = mockFetch(() => jsonResponse(routePayload));
  await withServer(async (server) => {
    const distance = await request(server, 'POST', '/api/routing/distance', {
      from: { lat: 26.2235, lon: 50.5876 },
      to: { lat: 26.2285, lon: 50.5860 },
      area: 'bahrain'
    });
    assert.equal(distance.status, 200);
    for (const field of ['haversine_distance_m', 'route_distance_m', 'duration_s', 'engine', 'area', 'warnings']) {
      assert.ok(field in distance.body);
    }
  });
  restore();
});

test('request id propagates to headers and error response', async () => {
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/api/routing/route', {
      locations: [{ lat: 260, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }]
    }, { 'x-request-id': 'req-test-1' });
    assert.equal(res.headers['x-request-id'], 'req-test-1');
    assert.equal(res.body.error.request_id, 'req-test-1');
  });
});

test('Valhalla timeout maps to 504', async () => {
  const restore = mockFetch((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/api/routing/route', {
      locations: [{ lat: 26.2235, lon: 50.5876 }, { lat: 26.2285, lon: 50.5860 }],
      area: 'bahrain'
    });
    assert.equal(res.status, 504);
    assert.equal(res.body.error.code, 'upstream_timeout');
  });
  restore();
});

test('optimization response marks heuristic as not optimal', async () => {
  const restore = mockFetch(() => jsonResponse(routePayload));
  await withServer(async (server) => {
    const res = await request(server, 'POST', '/api/routing/optimization', {
      start: { lat: 26.2235, lon: 50.5876 },
      jobs: [{ id: 'order_1', lat: 26.2285, lon: 50.5860 }],
      end: { lat: 26.2235, lon: 50.5876 },
      area: 'bahrain'
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.optimizer, 'nearest_neighbor');
    assert.equal(res.body.optimal, false);
  });
  restore();
});
