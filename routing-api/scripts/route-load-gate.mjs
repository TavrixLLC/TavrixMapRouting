import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const reportDir = resolve(repoRoot, 'reports');
const matrixPath = process.env.ROUTING_QUALITY_MATRIX_PATH || resolve(repoRoot, 'config', 'routing-quality-matrix.json');
const matrix = JSON.parse(await readFile(resolvePath(matrixPath), 'utf8'));
const baseUrl = process.env.ROUTING_BASE_URL || 'http://localhost:8080';
const durationSeconds = Number(process.env.ROUTING_LOAD_DURATION_SECONDS || 10);
const scenarioCooldownMs = Number(process.env.ROUTING_LOAD_SCENARIO_COOLDOWN_MS || 5000);
const loadMaxSockets = Number(process.env.ROUTING_LOAD_MAX_SOCKETS || 16);
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: loadMaxSockets, maxFreeSockets: loadMaxSockets });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: loadMaxSockets, maxFreeSockets: loadMaxSockets });
const route = matrix.routes[0];
const snap = matrix.snaps.find((item) => item.expect_matched);
const scenarios = [
  { name: 'route_50_rps', rps: 50, path: '/api/routing/route', body: { locations: route.locations, area: matrix.region_id } },
  { name: 'route_100_rps', rps: 100, path: '/api/routing/route', body: { locations: route.locations, area: matrix.region_id } },
  { name: 'snap_100_rps', rps: 100, path: '/api/routing/snap', body: { locations: [snap.location], area: matrix.region_id } },
  { name: 'matrix_controlled', rps: 5, path: '/api/routing/matrix', body: { locations: matrix.matrix.locations, area: matrix.region_id } },
  { name: 'isochrone_controlled', rps: 2, path: '/api/routing/isochrone', body: { ...matrix.isochrone, area: matrix.region_id } }
];

const summaries = [];
for (const scenario of scenarios) {
  await warmup(scenario);
  await delay(1100);
  summaries.push(await runScenario(scenario));
  await delay(scenarioCooldownMs);
}

const failed = summaries.filter((result) => result.error_rate > 0.001 || result.timeout_rate > 0 || (result.name.startsWith('route_') && result.p95_ms > 500) || (result.name.startsWith('snap_') && result.p95_ms > 250));
const report = { generated_at: new Date().toISOString(), duration_seconds: durationSeconds, base_url: baseUrl, region_id: matrix.region_id, matrix_path: relativePath(resolvePath(matrixPath)), passed: failed.length === 0, failed_scenarios: failed.map((item) => item.name), summaries };
await mkdir(reportDir, { recursive: true });
await writeFile(resolve(reportDir, 'routing-load-gate.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(reportDir, 'routing-load-gate.md'), markdown(report));
console.log(JSON.stringify(report, null, 2));
if (failed.length) process.exit(1);

async function warmup(scenario) {
  const count = scenario.rps >= 50 ? 25 : 5;
  for (let index = 0; index < count; index += 1) {
    await postJson(scenario.path, scenario.body).then((response) => response.body);
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function runScenario(scenario) {
  const latencies = [];
  const statusCounts = new Map();
  const errorMessages = new Map();
  let errors = 0;
  let timeouts = 0;
  const total = Math.ceil(scenario.rps * durationSeconds);
  const pending = [];
  const started = performance.now();
  for (let index = 0; index < total; index += 1) {
    const due = started + (index * 1000 / scenario.rps);
    const wait = due - performance.now();
    if (wait > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, wait));
    pending.push(send(scenario));
  }
  await Promise.all(pending);
  latencies.sort((a, b) => a - b);
  return {
    name: scenario.name,
    requests: total,
    p50_ms: percentile(latencies, 0.5),
    p95_ms: percentile(latencies, 0.95),
    p99_ms: percentile(latencies, 0.99),
    failed_requests: errors,
    timeout_requests: timeouts,
    status_codes: Object.fromEntries([...statusCounts.entries()].sort(([left], [right]) => Number(left) - Number(right))),
    error_messages: [...errorMessages.entries()].map(([message, count]) => ({ message, count })),
    error_rate: errors / total,
    timeout_rate: timeouts / total
  };

  async function send({ path, body }) {
    const requestStarted = performance.now();
    try {
      const response = await postJson(path, body);
      statusCounts.set(String(response.status), (statusCounts.get(String(response.status)) || 0) + 1);
      if (!response.ok) {
        errors += 1;
        recordError(`HTTP ${response.status}`);
      }
    } catch (error) {
      errors += 1;
      if (error.name === 'TimeoutError') timeouts += 1;
      recordError(`${error.name || 'Error'}: ${error.message}`);
    } finally {
      latencies.push(performance.now() - requestStarted);
    }
  }

  function recordError(message) {
    errorMessages.set(message, (errorMessages.get(message) || 0) + 1);
  }
}

function postJson(path, body, timeoutMs = 15000) {
  const target = new URL(path, baseUrl);
  const payload = JSON.stringify(body);
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;
  const agent = isHttps ? httpsAgent : httpAgent;

  return new Promise((resolvePromise, rejectPromise) => {
    const request = transport.request(target, {
      method: 'POST',
      agent,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolvePromise({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          body: Buffer.concat(chunks)
        });
      });
    });

    request.setTimeout(timeoutMs, () => {
      const error = new Error('Request timed out');
      error.name = 'TimeoutError';
      request.destroy(error);
    });
    request.on('error', rejectPromise);
    request.end(payload);
  });
}

function percentile(values, quantile) {
  if (!values.length) return null;
  return Math.round(values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)]);
}

function markdown(report) {
  const rows = report.summaries.map((item) => `| ${item.name} | ${item.requests} | ${item.p50_ms} | ${item.p95_ms} | ${item.p99_ms} | ${item.failed_requests ?? 'n/a'} | ${item.timeout_requests ?? 'n/a'} | ${item.error_rate} | ${item.timeout_rate} | ${JSON.stringify(item.status_codes || {})} |`).join('\n');
  return `# Routing Load Gate\n\n- Generated: ${report.generated_at}\n- Base URL: ${report.base_url}\n- Region: ${report.region_id || 'unresolved'}\n- Matrix: ${report.matrix_path || 'unresolved'}\n- Result: ${report.passed ? 'PASS' : 'FAIL'}\n- Failed scenarios: ${report.failed_scenarios.join(', ') || 'none'}\n\n| Scenario | Requests | p50 ms | p95 ms | p99 ms | Failed | Timeouts | Error rate | Timeout rate | Status codes |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n${rows}\n`;
}

function resolvePath(path) {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : resolve(repoRoot, path);
}

function relativePath(path) {
  return path.replace(`${repoRoot}\\`, '').replace(`${repoRoot}/`, '').replace(/\\/g, '/');
}
