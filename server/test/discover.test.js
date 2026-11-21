import test from 'node:test';
import assert from 'node:assert/strict';
import { TAILNET, readHttp } from './helpers.js';
import { isTailscaleIp, looksLikeUmbrel, normalizeAddress, probeAll, probeUmbrel, readTailnet, resolveName, tailnetKey, tailnetMap } from '../umbrel/discover.js';

test('addresses in any form', () => {
  const table = [
    ['100.97.142.86', 'http://100.97.142.86', '100.97.142.86', false],
    ['axial', 'http://axial', 'axial', true],
    ['axial.local', 'http://axial.local', 'axial.local', true],
    ['http://axial/mcp', 'http://axial', 'axial', true],
    ['https://x/', 'https://x', 'x', true],
    ['  AXIAL/mcp/  ', 'http://axial', 'axial', true],
    ['http://100.97.142.86:8080/mcp', 'http://100.97.142.86:8080', '100.97.142.86', false],
    ['http://axial/mcp/files/download?path=/Home/file.bin', 'http://axial', 'axial', true],
    ['axial.example-tailnet.ts.net.', 'http://axial.example-tailnet.ts.net.', 'axial.example-tailnet.ts.net.', true],
  ];
  for (const [input, url, host, isName] of table) assert.deepEqual(normalizeAddress(input), { url, host, isName }, input);
  assert.equal(normalizeAddress(''), null);
  assert.equal(normalizeAddress(undefined), null);
  for (const bad of ['ftp://axial', 'http://ax ial', 'http://user:pw@axial', 'http://axial/admin', 'http://', 'a_b']) assert.throws(() => normalizeAddress(bad), /bad address/, bad);
});

test('tailnet section: only 100.64/10 addresses and usable names are kept', () => {
  const t = readTailnet({
    self: { names: ['me'], ips: ['100.64.0.1', 'fd7a::1', '8.8.8.8'] },
    peers: [{ names: ['localhost'], ips: ['100.64.0.2'] }, { names: ['lan'], ips: ['192.168.1.5'] }, { names: ['<script>'], ips: ['100.64.0.3'] }, 'junk', { names: ['ok'], ips: ['100.64.0.4'], online: 'yes' }],
  });
  assert.deepEqual(t, { self: { names: ['me'], ips: ['100.64.0.1'], online: false }, peers: [{ names: ['ok'], ips: ['100.64.0.4'], online: false }] });
  assert.equal(readTailnet(undefined), null);
  assert.equal(readTailnet({ peers: [] }), null);
  // Online flips do not count as a change.
  const a = readTailnet(TAILNET);
  const b = readTailnet({ ...TAILNET, peers: TAILNET.peers.map((p) => ({ ...p, online: !p.online })) });
  assert.equal(tailnetKey(a), tailnetKey(b));
  assert.equal(isTailscaleIp('100.63.255.255'), false);
  assert.equal(isTailscaleIp('100.128.0.1'), false);
  assert.equal(isTailscaleIp('100.127.0.1'), true);
});

test('names resolve through the reported tailnet; loopback is not found', async () => {
  const map = tailnetMap([readTailnet(TAILNET)]);
  const noDns = async () => {
    throw new Error('ENOTFOUND');
  };
  assert.equal(await resolveName('axial', map, noDns), '100.64.0.17');
  assert.equal(await resolveName('AXIAL.local', map, noDns), '100.64.0.17');
  assert.equal(await resolveName('axial.example-tailnet.ts.net', map, noDns), '100.64.0.17');
  assert.equal(await resolveName('vps', map, noDns), '100.64.0.20');
  assert.equal(await resolveName('vps-8e6f2b1', map, noDns), '100.64.0.20');
  // Two peers called steamdeck: the DNS label wins over the other's HostName.
  assert.equal(await resolveName('steamdeck', map, noDns), '100.64.0.19');
  assert.equal(await resolveName('steamdeck-white', map, noDns), '100.64.0.11');
  assert.equal(map.byIp.get('100.64.0.17'), 'axial');
  // Not on the tailnet: DNS, but never loopback (xumbrel's own name inside its container).
  assert.equal(await resolveName('nas', map, async () => ({ address: '192.168.1.9' })), '192.168.1.9');
  assert.equal(await resolveName('elsewhere', map, async () => ({ address: '127.0.0.1' })), null);
  assert.equal(await resolveName('elsewhere', map, async () => [{ address: '::1' }]), null);
  assert.equal(await resolveName('elsewhere', map, noDns), null);
});

test('an Umbrel is told apart by its 401 on /mcp (recorded from axial)', async () => {
  const r = readHttp('umbrel/mcp-401.txt');
  assert.equal(r.status, 401);
  assert.equal(looksLikeUmbrel(r.status, r.headers, r.body), true);
  assert.equal(looksLikeUmbrel(200, r.headers, r.body), false);
  assert.equal(looksLikeUmbrel(401, new Headers({ 'www-authenticate': 'Basic' }), 'Unauthorized'), false);
  assert.equal(looksLikeUmbrel(401, new Headers(), r.body), false);
  // Through probeUmbrel with the recorded response, no token sent.
  const seen = [];
  const fetch = async (url, init) => {
    seen.push([url, init.headers]);
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  assert.equal(await probeUmbrel('100.64.0.17', { fetch }), true);
  assert.deepEqual(seen[0][0], 'http://100.64.0.17/mcp');
  assert.ok(!('authorization' in seen[0][1]));
  assert.equal(await probeUmbrel('100.64.0.17', { fetch: async () => { throw new Error('timeout'); } }), false);
});

test('probing: never outside 100.64/10, at most 4 at a time', async () => {
  let running = 0;
  let most = 0;
  const probed = [];
  const probe = async (ip) => {
    probed.push(ip);
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return ip.endsWith('.7');
  };
  const ips = Array.from({ length: 12 }, (_, i) => `100.64.0.${i}`).concat(['192.168.1.7', '127.0.0.7', '10.0.0.7', '100.64.0.7']);
  const found = await probeAll(ips, { probe });
  assert.deepEqual(found, ['100.64.0.7']);
  assert.equal(most, 4);
  assert.equal(probed.length, 12);
  assert.ok(probed.every(isTailscaleIp));
  // probeUmbrel itself refuses other addresses without fetching.
  let fetched = false;
  assert.equal(await probeUmbrel('192.168.1.7', { fetch: async () => (fetched = true) }), false);
  assert.equal(fetched, false);
});
