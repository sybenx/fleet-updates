import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.js';

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

export function tmpDir(prefix = 'fleet-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// An in-process server on a random port with a clock the test controls (real time by default,
// so agents that check expiry against their own clock agree with it).
export async function startServer(opts = {}) {
  const dataDir = opts.dataDir || tmpDir();
  const clock = { t: opts.t ?? Date.now() };
  // No real probes or DNS in tests unless a test brings its own.
  const app = createApp({
    dataDir,
    now: () => clock.t,
    devSigner: true,
    publicUrl: opts.publicUrl || '',
    probe: async () => false,
    lookup: async () => {
      throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    },
    ...opts.app,
  });
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

// A recorded HTTP response (curl -si) -> { status, headers, body }.
export function readHttp(file) {
  const raw = fs.readFileSync(path.join(fx, file), 'utf8');
  const [head, ...rest] = raw.split(/\r?\n\r?\n/);
  const lines = head.split(/\r?\n/);
  const status = Number(lines[0].split(' ')[1]);
  const headers = new Headers(lines.slice(1).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
  return { status, headers, body: rest.join('\n\n') };
}

// What the Go agent sends for the recorded fixture (agent/tailnet.go), written out by hand.
export const TAILNET = {
  self: { names: ['Example MacBook', 'mbp'], ips: ['100.64.0.21'], online: true },
  peers: [
    { names: ['steamdeck', 'steamdeck-white'], ips: ['100.64.0.11'] },
    { names: ['Took'], ips: ['100.64.0.12'], online: true },
    { names: ['xumbrel'], ips: ['100.64.0.13'], online: true },
    { names: ['pve'], ips: ['100.64.0.14'], online: true },
    { names: ['google-pixel-7a'], ips: ['100.64.0.15'] },
    { names: ['ipad-129'], ips: ['100.64.0.16'] },
    { names: ['axial'], ips: ['100.64.0.17'], online: true },
    { names: ['ambrel'], ips: ['100.64.0.18'], online: true },
    { names: ['steamdeck'], ips: ['100.64.0.19'] },
    { names: ['vps-8e6f2b1', 'vps'], ips: ['100.64.0.20'], online: true },
  ],
};

