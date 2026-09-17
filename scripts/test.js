// `npm test`: boot a throwaway server on a free port with an empty data dir, run the
// smoke test against it, and tear it down. Never touches a dev server or data/rooms.json.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const dataDir = mkdtempSync(join(tmpdir(), 'chiply-test-'));

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir },
  stdio: 'inherit',
});
const serverExit = new Promise((resolve) => server.once('exit', resolve));

async function waitForHealthy(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early (code ${server.exitCode})`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy');
}

let code = 1;
try {
  await waitForHealthy();
  const smoke = spawn(process.execPath, ['scripts/smoke.js'], {
    env: { ...process.env, SMOKE_URL: `ws://127.0.0.1:${port}/ws` },
    stdio: 'inherit',
  });
  code = await new Promise((resolve) => smoke.once('exit', (c) => resolve(c ?? 1)));
} catch (err) {
  console.error(err.message);
} finally {
  server.kill();
  await serverExit;
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(code);
