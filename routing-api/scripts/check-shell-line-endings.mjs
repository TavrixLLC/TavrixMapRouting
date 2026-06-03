import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const scriptsDir = resolve('..', 'scripts');
const files = (await readdir(scriptsDir)).filter((file) => file.endsWith('.sh'));
const failures = [];

for (const file of files) {
  const content = await readFile(resolve(scriptsDir, file), 'utf8');
  if (content.includes('\r')) failures.push(`${file}: contains CRLF line endings`);
  if (!content.startsWith('#!')) failures.push(`${file}: missing shebang`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Validated ${files.length} shell scripts: LF endings and shebangs are present.`);
