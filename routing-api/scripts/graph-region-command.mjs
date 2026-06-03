import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));
const regionId = args.region || process.env.VALHALLA_REGION;

if (!['build', 'validate', 'activate'].includes(command)) {
  fail('usage: npm run graph:<build|validate|activate> -- --region <region> [--build-id <id>] [--color <blue|green|auto>]');
}
if (!regionId) fail('--region is required');

const regionConfigPath = resolve(repoRoot, 'config', 'regions', `${regionId}.json`);
if (!existsSync(regionConfigPath)) fail(`missing region config: ${regionConfigPath}`);
const region = JSON.parse(await readFile(regionConfigPath, 'utf8'));
const regionEnv = {
  VALHALLA_REGION: region.region_id,
  VALHALLA_REGION_CONFIG_PATH: `/valhalla/config/regions/${region.region_id}.json`,
  VALHALLA_PBF_NAME: region.pbf_name,
  VALHALLA_PBF_URL: region.pbf_source,
  VALHALLA_PBF_PATH: `/valhalla/data/${region.pbf_name}`,
  VALHALLA_DOWNLOAD_PBF: 'true'
};

if (command === 'build') {
  run('docker', ['compose', '--profile', 'updater', 'run', '--rm', ...envArgs(regionEnv), 'routing-updater', '/opt/tavrix/scripts/update-pipeline.sh', '--build-only']);
} else if (command === 'validate') {
  const buildId = args['build-id'] || readLastBuildId();
  if (!buildId) fail('--build-id is required when active/.last_build_id is missing');
  run('docker', ['compose', '--profile', 'updater', 'run', '--rm', ...envArgs(regionEnv), 'routing-updater', '/opt/tavrix/scripts/validate-valhalla.sh', buildId]);
} else if (command === 'activate') {
  const buildId = args['build-id'] || readLastValidatedBuildId();
  const color = args.color || 'auto';
  if (!buildId) fail('--build-id is required when active/.last_validated_build_id is missing');
  if (!['auto', 'blue', 'green'].includes(color)) fail('--color must be auto, blue, or green');
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(repoRoot, 'scripts', 'activate-bluegreen.ps1'), '-Color', color, '-BuildId', buildId]);
  } else {
    run(resolve(repoRoot, 'scripts', 'activate-bluegreen.sh'), [color, buildId]);
  }
}

function envArgs(values) {
  return Object.entries(values).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
}

function readLastBuildId() {
  const file = resolve(repoRoot, 'active', '.last_build_id');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

function readLastValidatedBuildId() {
  const file = resolve(repoRoot, 'active', '.last_validated_build_id');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

function run(executable, commandArgs) {
  const result = spawnSync(executable, commandArgs, { cwd: repoRoot, stdio: 'inherit', shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
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

function fail(message) {
  console.error(message);
  process.exit(1);
}
