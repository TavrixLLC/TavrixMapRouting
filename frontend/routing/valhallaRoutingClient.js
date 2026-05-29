const ROUTE_SOURCE_ID = 'valhalla-route';
const ROUTE_LAYER_ID = 'valhalla-route-line';

function decodePolyline6(str) {
  let index = 0;
  let lat = 0;
  let lon = 0;
  const coordinates = [];
  const factor = 1e6;

  while (index < str.length) {
    let result = 1;
    let shift = 0;
    let byte;
    do {
      byte = str.charCodeAt(index++) - 63 - 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 1;
    shift = 0;
    do {
      byte = str.charCodeAt(index++) - 63 - 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);

    coordinates.push([lon / factor, lat / factor]);
  }

  return coordinates;
}

export async function fetchRoute({ origin, destination, costing = 'auto', units = 'kilometers', apiBaseUrl = '' }) {
  const response = await fetch(`${apiBaseUrl}/api/routing/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locations: [
        { lat: origin.lat, lon: origin.lon },
        { lat: destination.lat, lon: destination.lon }
      ],
      costing,
      units
    })
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error?.message || 'Routing request failed');
  }
  return body;
}

export function routeToGeoJson(route) {
  if (!route.geometry) {
    throw new Error('Route response did not include geometry');
  }

  return {
    type: 'Feature',
    properties: {
      distance: route.distance,
      duration: route.duration,
      units: route.units
    },
    geometry: {
      type: 'LineString',
      coordinates: decodePolyline6(route.geometry)
    }
  };
}

export function drawRoute(map, route, options = {}) {
  const feature = routeToGeoJson(route);
  const data = { type: 'FeatureCollection', features: [feature] };

  if (map.getSource(ROUTE_SOURCE_ID)) {
    map.getSource(ROUTE_SOURCE_ID).setData(data);
  } else {
    map.addSource(ROUTE_SOURCE_ID, { type: 'geojson', data });
  }

  if (!map.getLayer(ROUTE_LAYER_ID)) {
    map.addLayer({
      id: ROUTE_LAYER_ID,
      type: 'line',
      source: ROUTE_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': options.color || '#2563eb',
        'line-width': options.width || 5,
        'line-opacity': options.opacity || 0.85
      }
    });
  }

  return feature.properties;
}

export async function routeAndDraw(map, params) {
  const route = await fetchRoute(params);
  return drawRoute(map, route, params?.style);
}
