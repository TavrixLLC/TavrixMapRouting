import { routeAndDraw } from './valhallaRoutingClient.js';

export async function showExampleManamaRoute(map) {
  const summary = await routeAndDraw(map, {
    origin: { lat: 26.2235, lon: 50.5876 },
    destination: { lat: 26.2285, lon: 50.5860 },
    costing: 'auto',
    units: 'kilometers'
  });

  return {
    distance: summary.distance,
    durationMinutes: summary.duration == null ? null : Math.round(summary.duration / 60),
    units: summary.units
  };
}
