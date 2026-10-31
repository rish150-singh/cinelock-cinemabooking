import '../src/config/env.js';

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prismaCli = resolve(serverDirectory, '../node_modules/prisma/build/index.js');
const result = spawnSync(process.execPath, [prismaCli, ...process.argv.slice(2)], {
  cwd: serverDirectory,
  stdio: 'inherit'
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
