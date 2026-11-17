// main.ts — launcher: spawns the Go forge binary that lives next to this file
// and waits for it. The binary owns the whole lifecycle (bind, register with
// the trial environment, poll for done); this file only keeps the entry point
// a Node one, as the competition requires.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const binary = join(dir, 'forge');

const child = spawn(binary, [], { stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error('forge: failed to start the binary:', err);
  process.exit(1);
});
