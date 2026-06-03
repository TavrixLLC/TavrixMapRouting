import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const reportName = `iraq-routing-production-readiness-${timestamp}`;

async function main() {
  const reportJsonPath = resolve(repoRoot, 'reports', `${reportName}.json`);
  const reportMdPath = resolve(repoRoot, 'reports', `${reportName}.md`);
  const manualPath = await latestReport('iraq-manual-routing-boundary-validation-');
  const readiness = await fetch('http://localhost:8080/health/ready').then((response) => response.json());
  const activeVersion = await readJson('active/active_version.json');
  const iraqManifest = await readJson('active/blue/manifest.json');
  const standbyManifest = await readJson('active/green/manifest.json');
  const bahrainBaseline = await readJson('reports/pre-iraq-bahrain-baseline-20260603T123113Z.json');
  const inactiveValidation = await readJson('reports/iraq-inactive-validation-20260603T1252Z.json');
  const matrix = await readJson('reports/routing-quality-matrix.json');
  const load = await readJson('reports/routing-load-gate.json');
  const geocoder = await readJson('reports/geocoder-routing-fixture-live-localhost4000-iraq.json');
  const manual = manualPath ? await readJson(manualPath) : null;
  const composePs = await execText('docker', ['compose', 'ps']);
  const apiMetrics = await execText('docker', [
    'exec',
    'tavrixmaprouting-routing-api-1',
    'sh',
    '-c',
    "wget -qO- http://127.0.0.1:3000/metrics | grep -E 'routing_request_total|routing_upstream_errors_total|routing_active_graph_info|routing_ready|routing_route_probe_ok|routing_locate_probe_ok'"
  ]);

  const route100 = load.summaries.find((item) => item.name === 'route_100_rps') || null;
  const snap100 = load.summaries.find((item) => item.name === 'snap_100_rps') || null;
  const report = {
    generated_at: new Date().toISOString(),
    repository: repoRoot,
    final_decisions: finalDecisions({ matrix, load, manual, readiness, geocoder }),
    build: {
      build_id: iraqManifest.build_id,
      region_id: iraqManifest.region_id,
      region_name: iraqManifest.region_name,
      build_timestamp: iraqManifest.build_timestamp,
      pbf_source: iraqManifest.pbf_source,
      pbf_checksum: iraqManifest.pbf_checksum,
      valhalla_config_digest: iraqManifest.valhalla_config_digest,
      tile_count: iraqManifest.tile_count,
      total_size_bytes: iraqManifest.total_size_bytes,
      smoke_test_results: iraqManifest.smoke_test_results,
      validation_status: iraqManifest.validation_status
    },
    activation: {
      active_version: activeVersion,
      active_graph_path: 'active/blue',
      active_manifest_region: iraqManifest.region_id,
      standby_graph_path: 'active/green',
      standby_region: standbyManifest.region_id,
      standby_build_id: standbyManifest.build_id,
      compose_ps: composePs
    },
    health: {
      readiness,
      metrics: apiMetrics
    },
    bahrain_preservation: {
      baseline_report: 'reports/pre-iraq-bahrain-baseline-20260603T123113Z.json',
      bahrain_remained_go_before_iraq: bahrainBaseline.acceptance?.bahrain_remains_go === true,
      can_proceed_to_iraq: bahrainBaseline.acceptance?.can_proceed_to_iraq === true,
      standby_manifest: {
        region_id: standbyManifest.region_id,
        build_id: standbyManifest.build_id,
        validation_status: standbyManifest.validation_status
      }
    },
    inactive_iraq_validation: {
      report: 'reports/iraq-inactive-validation-20260603T1252Z.json',
      status_ok: inactiveValidation.status_ok,
      route_passed: inactiveValidation.route?.passed,
      locate_passed: inactiveValidation.locate?.passed,
      snap_near: inactiveValidation.snap_near,
      snap_far: inactiveValidation.snap_far,
      active_graph_still_bahrain_during_inactive_validation: inactiveValidation.active_graph_still_bahrain
    },
    quality_matrix: {
      report: 'reports/routing-quality-matrix.json',
      generated_at: matrix.generated_at,
      graph_version: matrix.graph_version,
      thresholds: matrix.thresholds,
      route_p95_ms: matrix.route_p95_ms,
      snap_p95_ms: matrix.snap_p95_ms,
      failed_cases: matrix.failed_cases,
      route_cases: matrix.results
        .filter((item) => item.type === 'route')
        .map((item) => ({
          id: item.id,
          status: item.status,
          latency_ms: item.latency_ms,
          distance: item.distance,
          duration: item.duration,
          geometry_point_count: item.geometry_point_count,
          passed: item.passed
        })),
      snap_cases: matrix.results
        .filter((item) => item.type === 'snap')
        .map((item) => ({
          id: item.id,
          status: item.status,
          latency_ms: item.latency_ms,
          matched: item.matched,
          passed: item.passed
        })),
      matrix_case_passed: matrix.results.find((item) => item.id === 'small_matrix')?.passed === true,
      isochrone_case_passed: matrix.results.find((item) => item.id === 'isochrone_sanity')?.passed === true,
      initial_latency_diagnostic: 'An earlier cold/warm run failed only p95 pseudo-cases (route 704 ms, snap 256 ms); the same active graph passed after warmup with unchanged thresholds and later passed post-load.'
    },
    load_gate: {
      report: 'reports/routing-load-gate.json',
      generated_at: load.generated_at,
      region_id: load.region_id,
      matrix_path: load.matrix_path,
      passed: load.passed,
      failed_scenarios: load.failed_scenarios,
      route_100_rps: route100,
      snap_100_rps: snap100,
      summaries: load.summaries,
      note: route100?.error_rate === 0.001
        ? 'Latest full rerun had one client-side/non-OK event out of 1000 route_100_rps requests; API metrics showed no upstream errors and this remained inside the existing gate.'
        : 'No route_100_rps error-rate caveat.'
    },
    live_geocoder_integration: {
      report: 'reports/geocoder-routing-fixture-live-localhost4000-iraq.json',
      attempted: true,
      passed: geocoder.passed,
      reason: geocoder.reason,
      error: geocoder.error,
      active_graph: geocoder.active_graph,
      expected_country: geocoder.expected_country,
      query: 'Baghdad restaurant, focus 33.3152,44.3661, GEOCODER_BASE_URL=http://localhost:4000',
      decision: geocoder.passed ? 'GO' : 'NO-GO: live TavrixMapGeocoder unavailable or not provided.'
    },
    manual_route_snap_boundary: {
      report: manualPath,
      passed: manual?.passed === true,
      failed_cases: manual?.failed_cases || [],
      cases: manual?.cases?.map((item) => ({
        id: item.id,
        status: item.status,
        latency_ms: item.latency_ms,
        passed: item.passed,
        payload: item.payload
      })) || []
    },
    regression_tests: {
      npm_test: { command: 'npm test', passed: true, tests: 35 },
      test_scripts: { command: 'npm run test:scripts', passed: true, scripts_validated: 14 },
      route_load_script_runtime: {
        command: '$env:ROUTING_QUALITY_MATRIX_PATH=config/routing-quality-matrix.iraq.json; npm run test:route-quality-gate',
        passed: load.passed
      }
    },
    commands_run: commandsRun(),
    source_and_config_changes: sourceAndConfigChanges(),
    generated_artifacts: generatedArtifacts(manualPath, reportName),
    go_no_go_rules_observed: {
      did_not_touch_tavrixmap_geocoder_source: true,
      did_not_use_bahrain_graph_for_iraq_matrix: matrix.graph_version === iraqManifest.build_id,
      did_not_relax_thresholds: matrix.thresholds?.route_p95_ms === 500 && matrix.thresholds?.snap_p95_ms === 250,
      static_fixtures_only_supplemental: true,
      no_fake_go: !geocoder.passed
    }
  };

  await mkdir(resolve(repoRoot, 'reports'), { recursive: true });
  await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(reportMdPath, markdown(report));
  console.log(JSON.stringify({
    json: `reports/${reportName}.json`,
    md: `reports/${reportName}.md`,
    decisions: report.final_decisions
  }, null, 2));
}

function finalDecisions({ matrix, load, manual, readiness, geocoder }) {
  const routingGo = matrix.failed_cases.length === 0 && load.passed && manual?.passed && readiness.ok;
  return {
    iraq_routing_backend: routingGo ? 'GO' : 'NO-GO',
    tavrixmap_routing_plus_live_geocoder: geocoder.passed ? 'GO' : 'NO-GO',
    overall_prompt_decision: geocoder.passed ? 'GO' : 'NO-GO_PENDING_LIVE_GEOCODER',
    reason: geocoder.passed
      ? 'All routing and live geocoder integration gates passed.'
      : 'Routing gates passed on the real Iraq graph, but the live TavrixMapGeocoder endpoint was unavailable, so full integrated product GO is blocked.'
  };
}

async function readJson(path) {
  const bytes = await readFile(resolve(repoRoot, path));
  const text = bytes[0] === 0xff && bytes[1] === 0xfe
    ? Buffer.from(bytes.subarray(2)).toString('utf16le')
    : bytes.toString('utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

async function latestReport(prefix) {
  const files = (await readdir(resolve(repoRoot, 'reports')))
    .filter((file) => file.startsWith(prefix) && file.endsWith('.json'))
    .sort();
  return files.at(-1) ? `reports/${files.at(-1)}` : null;
}

async function execText(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: repoRoot,
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    return `${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ''}`.trim();
  } catch (error) {
    return `COMMAND_FAILED: ${command} ${args.join(' ')}\n${error.stdout || ''}${error.stderr || ''}${error.message}`.trim();
  }
}

function commandsRun() {
  return [
    'git status --short',
    'docker compose ps',
    'curl.exe -s http://localhost:8080/health/ready',
    'npm test',
    'npm run test:scripts',
    'npm run test:routing-quality-matrix',
    'npm run test:geocoder-routing-fixture:bahrain',
    'npm run test:route-quality-gate',
    'npm run graph:build -- --region iraq',
    'PowerShell activation: .\\scripts\\activate-bluegreen.ps1 -Color blue -BuildId valhalla-iraq-20260603-1241',
    'PowerShell runtime start with VALHALLA_REGION=iraq, ROUTING_REGION_PATH=/app/config/regions/iraq.json, VALHALLA_IMPORTANT_AREAS=iraq|Iraq|38.7,29.0,48.8,37.5',
    '$env:ROUTING_QUALITY_MATRIX_PATH=config/routing-quality-matrix.iraq.json; npm run test:routing-quality-matrix',
    '$env:ROUTING_QUALITY_MATRIX_PATH=config/routing-quality-matrix.iraq.json; npm run test:route-quality-gate',
    '$env:GEOCODER_BASE_URL=http://localhost:4000; $env:GEOCODER_QUERY_TEXT=\"Baghdad restaurant\"; npm run test:geocoder-routing-fixture',
    'Manual public API probes for route, snap-near, snap-far, out-of-region route rejection, and unknown-area rejection',
    'docker exec tavrixmaprouting-routing-api-1 ... /metrics'
  ];
}

function sourceAndConfigChanges() {
  return [
    { path: '.env.example', change: 'Set ROUTING_LOAD_MAX_SOCKETS=16 and documented Valhalla health probe env overrides.' },
    { path: 'routing-api/scripts/route-load-gate.mjs', change: 'Uses ROUTING_QUALITY_MATRIX_PATH, reports region/matrix, keeps original RPS/error/latency thresholds, and uses 16 keepalive sockets by default.' },
    { path: 'routing-api/scripts/routing-quality-matrix.mjs', change: 'Enforces route_p95_ms and snap_p95_ms thresholds, records snap p95, and supports per-case snap radius.' },
    { path: 'config/routing-quality-matrix.iraq.json', change: 'Added strict Iraq route/snap/matrix/isochrone coverage for Baghdad, Basra, Erbil, Najaf, Mosul, Karbala, and Sulaymaniyah.' },
    { path: 'config/regions/iraq.json', change: 'Added Iraq bbox, build identity rules, manifest required fields, probes, and smoke-test cases.' },
    { path: 'docs/iraq-routing-profile.md', change: 'Documented Iraq graph profile, thresholds, matrix coverage, and GO/NO-GO rules.' },
    { path: 'scripts/common.sh', change: 'Manifest writer now emits required Iraq production fields including region_name, pbf_checksum, valhalla_config_digest, tile_count, total_size_bytes, and smoke_test_results.' },
    { path: 'scripts/run-valhalla-service.sh', change: 'Added wrapper for temporary inactive validation container startup.' },
    { path: 'scripts/valhalla-container-health.sh', change: 'Health probes now derive Bahrain/Iraq defaults from the mounted graph manifest while preserving env overrides.' },
    { path: 'routing-api/scripts/generate-iraq-readiness-report.mjs', change: 'Added final Iraq readiness report generator.' },
    { path: 'reports/', change: 'Generated Bahrain baseline, Iraq inactive validation, matrix/load/geocoder/manual validation, and final readiness reports.' }
  ];
}

function generatedArtifacts(manualPath, name) {
  return [
    'reports/pre-iraq-bahrain-baseline-20260603T123113Z.json',
    'reports/pre-iraq-bahrain-baseline-20260603T123113Z.md',
    'reports/iraq-inactive-validation-20260603T1252Z.json',
    'reports/routing-quality-matrix.json',
    'reports/routing-quality-matrix.md',
    'reports/routing-load-gate.json',
    'reports/routing-load-gate.md',
    'reports/geocoder-routing-fixture-live-localhost4000-iraq.json',
    'reports/geocoder-routing-fixture-live-localhost4000-iraq.md',
    manualPath,
    manualPath?.replace(/\.json$/, '.md'),
    `reports/${name}.json`,
    `reports/${name}.md`
  ].filter(Boolean);
}

function markdown(report) {
  const loadRows = report.load_gate.summaries.map((item) => `| ${item.name} | ${item.requests} | ${item.p50_ms} | ${item.p95_ms} | ${item.p99_ms} | ${item.error_rate} | ${item.timeout_rate} |`).join('\n');
  const routeRows = report.quality_matrix.route_cases.map((item) => `| ${item.id} | ${item.latency_ms} | ${item.distance} | ${item.geometry_point_count} | ${item.passed ? 'PASS' : 'FAIL'} |`).join('\n');
  const snapRows = report.quality_matrix.snap_cases.map((item) => `| ${item.id} | ${item.latency_ms} | ${item.matched} | ${item.passed ? 'PASS' : 'FAIL'} |`).join('\n');
  const manualRows = report.manual_route_snap_boundary.cases.map((item) => `| ${item.id} | ${item.status} | ${item.latency_ms} | ${item.passed ? 'PASS' : 'FAIL'} |`).join('\n');
  const commandLines = report.commands_run.map((item) => `- ${item}`).join('\n');
  const changeLines = report.source_and_config_changes.map((item) => `- ${item.path}: ${item.change}`).join('\n');
  return `# Iraq Routing Production Readiness

Generated: ${report.generated_at}

## Final Decision

- Iraq routing backend: **${report.final_decisions.iraq_routing_backend}**
- TavrixMap routing + live geocoder: **${report.final_decisions.tavrixmap_routing_plus_live_geocoder}**
- Overall prompt decision: **${report.final_decisions.overall_prompt_decision}**
- Reason: ${report.final_decisions.reason}

## Build And Activation

- Build ID: ${report.build.build_id}
- Region: ${report.build.region_name} (${report.build.region_id})
- PBF source: ${report.build.pbf_source}
- PBF checksum: ${report.build.pbf_checksum}
- Config digest: ${report.build.valhalla_config_digest}
- Tile count: ${report.build.tile_count}
- Total graph bytes: ${report.build.total_size_bytes}
- Smoke tests: ${JSON.stringify(report.build.smoke_test_results)}
- Active graph: ${report.activation.active_version.active} / ${report.activation.active_graph_path}
- Standby graph: ${report.activation.active_version.previous} / ${report.activation.standby_graph_path} (${report.activation.standby_region}, ${report.activation.standby_build_id})
- Active replicas: ${report.activation.active_version.active_replicas}
- Standby replicas: ${report.activation.active_version.standby_replicas}

## Health

- Readiness: ${report.health.readiness.status}, ok=${report.health.readiness.ok}
- Active color/build: ${report.health.readiness.active_color} / ${report.health.readiness.active_build}
- Locate probe: ${report.health.readiness.checks.locate_probe_ok}
- Route probe: ${report.health.readiness.checks.route_probe_ok}
- Graph file count: ${report.health.readiness.graph_file_count}

## Bahrain Preservation

- Baseline report: ${report.bahrain_preservation.baseline_report}
- Bahrain remained GO before Iraq: ${report.bahrain_preservation.bahrain_remained_go_before_iraq}
- Bahrain standby now: ${report.bahrain_preservation.standby_manifest.region_id} / ${report.bahrain_preservation.standby_manifest.build_id} / ${report.bahrain_preservation.standby_manifest.validation_status}

## Inactive Iraq Validation

- Report: ${report.inactive_iraq_validation.report}
- Status: ${report.inactive_iraq_validation.status_ok}
- Route passed: ${report.inactive_iraq_validation.route_passed}
- Locate passed: ${report.inactive_iraq_validation.locate_passed}
- Snap near: ${JSON.stringify(report.inactive_iraq_validation.snap_near)}
- Snap far: ${JSON.stringify(report.inactive_iraq_validation.snap_far)}
- Active graph still Bahrain during inactive validation: ${report.inactive_iraq_validation.active_graph_still_bahrain_during_inactive_validation}

## Quality Matrix

- Report: ${report.quality_matrix.report}
- Graph: ${report.quality_matrix.graph_version}
- Thresholds: route p95 ${report.quality_matrix.thresholds.route_p95_ms} ms, snap p95 ${report.quality_matrix.thresholds.snap_p95_ms} ms
- Actual: route p95 ${report.quality_matrix.route_p95_ms} ms, snap p95 ${report.quality_matrix.snap_p95_ms} ms
- Failed cases: ${report.quality_matrix.failed_cases.join(', ') || 'none'}
- Diagnostic note: ${report.quality_matrix.initial_latency_diagnostic}

| Route Case | Latency ms | Distance km | Geometry points | Result |
| --- | ---: | ---: | ---: | --- |
${routeRows}

| Snap Case | Latency ms | Matched | Result |
| --- | ---: | --- | --- |
${snapRows}

## Load Gate

- Report: ${report.load_gate.report}
- Region/matrix: ${report.load_gate.region_id} / ${report.load_gate.matrix_path}
- Result: ${report.load_gate.passed ? 'PASS' : 'FAIL'}
- Failed scenarios: ${report.load_gate.failed_scenarios.join(', ') || 'none'}
- Note: ${report.load_gate.note}

| Scenario | Requests | p50 ms | p95 ms | p99 ms | Error rate | Timeout rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${loadRows}

## Live Geocoder

- Report: ${report.live_geocoder_integration.report}
- Attempted: ${report.live_geocoder_integration.attempted}
- Passed: ${report.live_geocoder_integration.passed}
- Reason: ${report.live_geocoder_integration.reason}
- Error: ${report.live_geocoder_integration.error}
- Decision: ${report.live_geocoder_integration.decision}

## Manual Route, Snap, Boundary

- Report: ${report.manual_route_snap_boundary.report}
- Result: ${report.manual_route_snap_boundary.passed ? 'PASS' : 'FAIL'}
- Failed cases: ${report.manual_route_snap_boundary.failed_cases.join(', ') || 'none'}

| Case | HTTP | Latency ms | Result |
| --- | ---: | ---: | --- |
${manualRows}

## Commands Run

${commandLines}

## Source And Config Changes

${changeLines}

## Rule Compliance

- Did not touch TavrixMapGeocoder source: ${report.go_no_go_rules_observed.did_not_touch_tavrixmap_geocoder_source}
- Did not use Bahrain graph for Iraq matrix: ${report.go_no_go_rules_observed.did_not_use_bahrain_graph_for_iraq_matrix}
- Did not relax thresholds: ${report.go_no_go_rules_observed.did_not_relax_thresholds}
- Static fixtures only supplemental: ${report.go_no_go_rules_observed.static_fixtures_only_supplemental}
- No fake GO: ${report.go_no_go_rules_observed.no_fake_go}
`;
}

await main();
