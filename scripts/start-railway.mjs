#!/usr/bin/env node
/**
 * ONE RAILWAY SERVICE, TWO PROCESSES — the console on loopback, the web app on the public port.
 *
 * The console (apps/console) holds a write connection to the database and can
 * spawn paid runs, so it never listens on a public interface here: it is
 * started with no `PORT` and binds 127.0.0.1:4478. The web app (apps/web) is
 * the only thing Railway routes to; it checks the sign-in and forwards to the
 * console with the console password attached server-side.
 *
 * Supervision is deliberately dumb: if either process exits, this exits with
 * its code and Railway's restart policy brings the pair back together. Two
 * half-alive processes that each think the other is fine is the failure a
 * cleverer supervisor would invent.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE_PORT = '4478';

const children = [];
function run(name, cwd, args, env) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code, signal) => {
    process.stderr.write(`[start] ${name} exited (${signal ?? code}) — stopping the service so Railway restarts both\n`);
    for (const c of children) if (c !== child && c.exitCode === null) c.kill('SIGTERM');
    process.exit(code ?? 1);
  });
  children.push(child);
}

// The console must not see Railway's PORT, or it would try to bind the public port.
const { PORT: publicPort = '8080', ...rest } = process.env;
run('console', resolve(ROOT, 'apps/console'), ['dist/server.js'], { ...rest, PORT: '', TMOS_CONSOLE_PORT: CONSOLE_PORT, TMOS_CONSOLE_BIND: '127.0.0.1' });
run('web', resolve(ROOT, 'apps/web'), [resolve(ROOT, 'apps/web/node_modules/next/dist/bin/next'), 'start', '-H', '0.0.0.0', '-p', publicPort], {
  TMOS_CONSOLE_URL: `http://127.0.0.1:${CONSOLE_PORT}`,
  NODE_ENV: 'production',
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { for (const c of children) c.kill(sig); });
