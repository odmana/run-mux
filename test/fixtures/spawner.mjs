// Spawns a grandchild that would outlive a naive single-pid kill, then prints
// its pid. Used to prove tree-killing works on both platforms.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, 'service.mjs'), '--label', 'grandchild'], {
  stdio: ['ignore', 'inherit', 'inherit'],
});

process.stdout.write(`spawner: grandchild pid ${child.pid}\n`);

setInterval(() => {
  process.stdout.write('spawner: alive\n');
}, 200);
