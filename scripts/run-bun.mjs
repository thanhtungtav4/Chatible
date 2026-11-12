import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const executable = process.platform === 'win32' ? 'bun.exe' : 'bun';
const candidates = [process.env.BUN_BIN, executable, join(homedir(), '.bun', 'bin', executable)].filter(Boolean);

for (const candidate of candidates) {
  const result = spawnSync(candidate, ['test', ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.error?.code === 'ENOENT') continue;
  if (result.error) {
    console.error(`Could not run Bun at ${candidate}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

console.error('Bun is required. Install Bun or set BUN_BIN to its executable path.');
process.exit(1);
