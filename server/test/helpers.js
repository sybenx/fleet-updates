import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';

export function tmpDir(prefix = 'fleet-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// An in-process server on a random port with a clock the test controls (real time by default,
// so agents that check expiry against their own clock agree with it).
export async function startServer(opts = {}) {
  const dataDir = opts.dataDir || tmpDir();
  const clock = { t: opts.t ?? Date.now() };
  const app = createApp({ dataDir, now: () => clock.t, devSigner: true, publicUrl: opts.publicUrl || '', ...opts.app });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    app,
    dataDir,
    clock,
    async close() {
      await app.idle();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

export async function call(url, method, p, body) {
  const res = await fetch(url + p, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

// What the page does on Update all / Update: draft, sign, post.
export async function approve(url, machineId, only = []) {
  const d = await call(url, 'POST', `/api/machines/${machineId}/draft`, { only });
  if (d.status !== 200) return d;
  const s = await call(url, 'POST', '/api/dev/sign', { event: d.json.event });
  return call(url, 'POST', `/api/machines/${machineId}/approval`, { event: s.json.event });
}
