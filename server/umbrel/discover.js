// Finding Umbrels: addresses in any form, tailnet names, and spotting an Umbrel on the tailnet.
//
// The dashboard runs in a container on xumbrel that cannot resolve tailnet names (no MagicDNS;
// public DNS; "xumbrel" is 127.0.0.1, the container itself). The agents that have Tailscale send
// what `tailscale status --json` says (the report's `tailnet` section), and the names are
// resolved from that.

import dns from 'node:dns/promises';
import net from 'node:net';

export const PROBE_TIMEOUT_MS = 3000;
export const PROBE_CONCURRENCY = 4;

// 100.64.0.0/10: the only addresses Tailscale hands out, and the only ones ever probed.
export function isTailscaleIp(ip) {
  if (net.isIPv4(ip) !== true) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

export function isLoopback(ip) {
  if (net.isIPv4(ip)) return ip.startsWith('127.') || ip === '0.0.0.0';
  const v = String(ip).toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('::ffff:127.');
}

// "100.97.142.86", "axial", "axial.local", "http://axial/mcp", "https://x/", "axial:8080/mcp/"
// -> { url: "http://axial", host: "axial", isName: true }. Empty -> null. Throws on anything else.
export function normalizeAddress(input) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('bad address');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad address');
  if (u.username || u.password || !u.hostname) throw new Error('bad address');
  // The Umbrel's base address: the path may be /mcp (and below it, as in a files link), nothing else.
  const p = u.pathname.replace(/\/+$/, '');
  if (p && !/^\/mcp(\/|$)/.test(p)) throw new Error('bad address');
  const host = u.hostname.toLowerCase();
  const bare = host.replace(/^\[|\]$/g, '');
  if (!net.isIP(bare) && !/^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*\.?$/.test(host)) throw new Error('bad address');
  const url = `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
  return { url, host: bare, isName: !net.isIP(bare) };
}

// ---- the report's tailnet section ----

const NAME = /^[\w .'’-]{1,63}$/u;

function cleanNode(n) {
  if (!n || typeof n !== 'object') return null;
  const ips = (Array.isArray(n.ips) ? n.ips : []).map(String).filter(isTailscaleIp).slice(0, 4);
  const names = (Array.isArray(n.names) ? n.names : [])
    .map((x) => String(x).trim())
    .filter((x) => NAME.test(x) && x.toLowerCase() !== 'localhost')
    .slice(0, 4);
  if (!ips.length || !names.length) return null;
  return { names, ips, online: n.online === true };
}

// What the dashboard keeps of a report's `tailnet` (untrusted shape; signed by a machine it added).
// -> { self, peers } or null when absent or empty.
export function readTailnet(t) {
  if (!t || typeof t !== 'object') return null;
  const self = cleanNode(t.self);
  const peers = (Array.isArray(t.peers) ? t.peers : []).slice(0, 500).map(cleanNode).filter(Boolean);
  if (!self && !peers.length) return null;
  return { self, peers };
}

// What decides "the tailnet changed" (Online flips all the time and does not count).
export function tailnetKey(t) {
  if (!t) return '';
  const rows = [t.self, ...t.peers].filter(Boolean).map((n) => `${n.ips.join(',')}=${n.names.join(',').toLowerCase()}`);
  return rows.sort().join('|');
}

// One merged view from every agent's latest tailnet section.
// -> { byName: Map(lowercase name -> ip), byIp: Map(ip -> display name) }
export function tailnetMap(tailnets) {
  const nodes = [];
  for (const t of tailnets) if (t) nodes.push(...[t.self, ...t.peers].filter(Boolean));
  // The DNS label (last name) is unique on a tailnet; HostNames may repeat ("steamdeck"). Labels
  // first, then HostNames only where nothing took the name yet; online nodes before offline ones.
  nodes.sort((a, b) => Number(b.online) - Number(a.online));
  const byName = new Map();
  const byIp = new Map();
  for (const n of nodes) {
    const label = n.names[n.names.length - 1];
    if (!byName.has(label.toLowerCase())) byName.set(label.toLowerCase(), n.ips[0]);
    if (!byIp.has(n.ips[0])) byIp.set(n.ips[0], label);
  }
  for (const n of nodes) for (const name of n.names) if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), n.ips[0]);
  return { byName, byIp };
}

// A name -> an IP: the tailnet map by first label ("axial.local" is axial), then normal DNS.
// Loopback counts as not found (inside the container that is the container itself).
export async function resolveName(host, map, lookup = (h) => dns.lookup(h, { family: 4 })) {
  const first = String(host).toLowerCase().replace(/\.$/, '').split('.')[0];
  const fromTailnet = map.byName.get(first) || map.byName.get(String(host).toLowerCase());
  if (fromTailnet) return fromTailnet;
  try {
    const r = await lookup(host);
    const ip = Array.isArray(r) ? r[0]?.address : r?.address;
    if (ip && !isLoopback(ip)) return ip;
  } catch {}
  return null;
}

// ---- is it an Umbrel? ----

// umbrelOS answers GET /mcp without a token with 401, `www-authenticate: Bearer`, a JSON-RPC error
// (-32001 Unauthorized), and its own CSP that allows https://apps.umbrel.com
// (test/fixtures/umbrel/mcp-401.txt). The 401 plus the JSON-RPC error plus one of the other two.
export function looksLikeUmbrel(status, headers, body) {
  if (status !== 401) return false;
  const h = (k) => String((headers.get ? headers.get(k) : headers[k]) || '');
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    return false;
  }
  if (!j || j.jsonrpc !== '2.0' || !j.error) return false;
  return /apps\.umbrel\.com/i.test(h('content-security-policy')) || /^bearer\b/i.test(h('www-authenticate'));
}

// GET http://<ip>/mcp, no token, 3 s. Never anything but a 100.64/10 address.
export async function probeUmbrel(ip, { fetch: f = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (!isTailscaleIp(ip)) return false;
  try {
    const res = await f(`http://${ip}/mcp`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json, text/event-stream' } });
    const body = res.status === 401 ? (await res.text()).slice(0, 4096) : '';
    if (res.status !== 401) res.body?.cancel?.().catch?.(() => {});
    return looksLikeUmbrel(res.status, res.headers, body);
  } catch {
    return false;
  }
}

// Probes the IPs, at most `concurrency` at a time. -> the IPs that look like Umbrels.
export async function probeAll(ips, { concurrency = PROBE_CONCURRENCY, probe = probeUmbrel, ...opts } = {}) {
  const queue = [...new Set(ips)].filter(isTailscaleIp);
  const found = [];
  async function worker() {
    while (queue.length) {
      const ip = queue.shift();
      if (await probe(ip, opts)) found.push(ip);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return found;
}
