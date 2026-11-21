import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, call, approve, tmpDir, TAILNET, readHttp } from './helpers.js';
import { itemId, newSecretKey, publicKey, reportTemplate, signEvent } from '../protocol.js';
import { createUmbrelAdapter } from '../umbrel/adapter.js';

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');
const read = (p) => fs.readFileSync(path.join(fx, p), 'utf8');
const MAC_ITEMS = [
  { channel: 'brew-formula', name: 'jq', title: 'jq', current: '1.7', latest: '1.7.1', flags: {} },
  { channel: 'brew-formula', name: 'node@20', title: 'node@20', current: '20.10.0', latest: '20.18.0', flags: { pinned: true } },
  { channel: 'brew-cask', name: 'zoom', title: 'Zoom', current: '6.0.0', latest: '6.1.0', flags: { pkg: true } },
  { channel: 'brew-cask', name: 'discord', title: 'Discord', current: '0.0.300', latest: '0.0.301', flags: { apps: ['Discord.app'], running: true } },
];

async function withServer(fn, opts) {
  const s = await startServer(opts);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

// Join as a machine the way the agent does: a join token from the page, then register a key.
async function joinMachine(s, os = 'mac', name = '') {
  const j = await call(s.url, 'POST', '/api/joins', { os, name });
  assert.equal(j.status, 200, j.text);
  const token = /t=([A-Za-z0-9_-]+)/.exec(j.json.command)?.[1] || /FLEET_JOIN: "([^"]+)"/.exec(j.json.command)?.[1];
  const sk = newSecretKey();
  const r = await call(s.url, 'POST', '/api/agent/register', { join: token, os, host: 'h1', pubkey: publicKey(sk) });
  assert.equal(r.status, 200, r.text);
  return { sk, id: r.json.machine, approver: r.json.approver, token, command: j.json.command };
}

const nowS = (s) => Math.floor(s.clock.t / 1000);
function sendReport(s, m, content = {}, createdAt) {
  const ev = signEvent(reportTemplate({ machineId: m.id, os: 'mac', host: 'h1', items: MAC_ITEMS, createdAt: createdAt ?? nowS(s), ...content }), m.sk);
  return call(s.url, 'POST', '/api/agent/report', ev);
}

test('page and its files are served', () =>
  withServer(async (s) => {
    const r = await fetch(s.url + '/');
    assert.match(r.headers.get('content-type'), /text\/html/);
    for (const f of ['/app.js', '/signer.js', '/style.css', '/icon.svg']) assert.equal((await fetch(s.url + f)).status, 200, f);
  }));

test('page copy: no em dashes', () => {
  for (const f of ['index.html', 'app.js', 'signer.js', 'style.css']) assert.ok(!fs.readFileSync(path.join(fx, '..', '..', 'server', 'page', f), 'utf8').includes('—'), f);
});

test('join commands carry the approver key; a join works once and for an hour', () =>
  withServer(async (s) => {
    const approver = s.app.signer.pubkey;
    const j = await call(s.url, 'POST', '/api/joins', { os: 'mac', name: 'Mac' });
    assert.match(j.json.command, new RegExp(`^curl -fsSL '${s.url}/install/mac\\?t=[A-Za-z0-9_-]+' \\| FLEET_APPROVER=${approver} sh$`));
    assert.match(j.json.catch, /mas/);
    const w = await call(s.url, 'POST', '/api/joins', { os: 'windows' });
    assert.match(w.json.command, /^\$env:FLEET_APPROVER='[0-9a-f]{64}'; irm '.*\/install\/windows\?t=.*' \| iex$/);
    const d = await call(s.url, 'POST', '/api/joins', { os: 'dockge' });
    assert.match(d.json.command, /FLEET_JOIN: "[A-Za-z0-9_-]+"/);
    assert.match(d.json.command, /\/data\/docker\.sock/);

    const token = /t=([A-Za-z0-9_-]+)/.exec(j.json.command)[1];
    const script = await (await fetch(`${s.url}/install/mac?t=${token}`)).text();
    assert.ok(script.startsWith(`#!/bin/sh\nFLEET_URL='${s.url}'\nFLEET_JOIN='${token}'\n`));
    const pk = publicKey(newSecretKey());
    assert.equal((await call(s.url, 'POST', '/api/agent/register', { join: token, os: 'mac', host: 'h', pubkey: pk })).status, 200);
    // Used: the script and the register call both say no.
    assert.match(await (await fetch(`${s.url}/install/mac?t=${token}`)).text(), /expired or was used/);
    assert.equal((await call(s.url, 'POST', '/api/agent/register', { join: token, os: 'mac', host: 'h', pubkey: publicKey(newSecretKey()) })).status, 403);
    // Expired after an hour.
    const j2 = await call(s.url, 'POST', '/api/joins', { os: 'linux' });
    s.clock.t += 3600 * 1000 + 1;
    const t2 = /t=([A-Za-z0-9_-]+)/.exec(j2.json.command)[1];
    assert.equal((await call(s.url, 'POST', '/api/agent/register', { join: t2, os: 'linux', host: 'h', pubkey: publicKey(newSecretKey()) })).status, 403);
    const st = (await call(s.url, 'GET', '/api/state')).json;
    assert.equal(st.machines[0].uninstall, `curl -fsSL '${s.url}/install/mac/uninstall' | sh`);
    assert.equal(st.machines[0].name, 'Mac');
  }));

test('install and agent files are public; the page API needs JSON', () =>
  withServer(async (s) => {
    assert.equal((await fetch(s.url + '/install/mac/uninstall')).status, 200);
    assert.equal((await fetch(s.url + '/install/windows/uninstall')).status, 200);
    assert.equal((await fetch(s.url + '/api/agent/files/linux/fleet-agent.timer')).status, 200);
    assert.equal((await fetch(s.url + '/api/agent/files/mac/..%2f..%2fpackage.json')).status, 404);
    assert.equal((await fetch(s.url + '/api/agent/bin/evil')).status, 404);
    const r = await fetch(s.url + '/api/joins', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"os":"mac"}' });
    assert.equal(r.status, 415);
  }));

test('agent binaries are served with their sha256', async () => {
  const dist = tmpDir();
  fs.writeFileSync(path.join(dist, 'fleet-agent-linux-amd64'), 'binary');
  await withServer(
    async (s) => {
      assert.equal(await (await fetch(s.url + '/api/agent/bin/fleet-agent-linux-amd64')).text(), 'binary');
      const sha = await (await fetch(s.url + '/api/agent/bin/fleet-agent-linux-amd64.sha256')).text();
      assert.equal(sha, '9a3a45d01531a20e89ac6ae10b0b0beb0492acd7216a368aa062d1a5fecaf9cd  fleet-agent-linux-amd64\n');
      assert.equal((await fetch(s.url + '/api/agent/bin/fleet-agent-darwin-arm64')).status, 404);
    },
    { app: { distDir: dist } }
  );
});

test('a report from a machine key the dashboard did not add is refused', () =>
  withServer(async (s) => {
    const m = await joinMachine(s);
    const stranger = { id: m.id, sk: newSecretKey() };
    assert.equal((await sendReport(s, stranger)).status, 403);
    assert.equal((await sendReport(s, m)).status, 200);
    // A known key reporting for another machine id is refused too.
    const other = await joinMachine(s, 'linux');
    assert.equal((await sendReport(s, { id: other.id, sk: m.sk })).status, 403);
  }));

test('reports are snapshots: the latest replaces the last, older ones are ignored', () =>
  withServer(async (s) => {
    const m = await joinMachine(s);
    await sendReport(s, m);
    let st = (await call(s.url, 'GET', '/api/state')).json.machines[0];
    assert.equal(st.items.length, 4);
    assert.equal(st.pending, 3); // node@20 is pinned
    const needs = st.needs.map((n) => n.text);
    assert.ok(needs.includes('Quit Discord first'));
    assert.ok(needs.includes('Zoom needs your password'));
    await sendReport(s, m, { items: MAC_ITEMS.slice(0, 1) });
    st = (await call(s.url, 'GET', '/api/state')).json.machines[0];
    assert.equal(st.items.length, 1);
    await sendReport(s, m, {}, nowS(s) - 100);
    assert.equal((await call(s.url, 'GET', '/api/state')).json.machines[0].items.length, 1);
  }));

test('approvals: page drafts, signer signs, dashboard keeps the latest; counters only go up', () =>
  withServer(async (s) => {
    const m = await joinMachine(s);
    assert.equal((await call(s.url, 'POST', `/api/machines/${m.id}/draft`, {})).status, 409); // no report yet
    await sendReport(s, m);
    const d = (await call(s.url, 'POST', `/api/machines/${m.id}/draft`, {})).json.event;
    assert.deepEqual(d.tags.slice(0, 3).map((t) => t[0]), ['d', 'report', 'counter']);
    assert.equal(d.tags.find((t) => t[0] === 'counter')[1], '1');
    assert.ok(d.tags.find((t) => t[0] === 'expiration'));
    assert.equal(d.created_at, nowS(s));
    const signed = (await call(s.url, 'POST', '/api/dev/sign', { event: d })).json.event;
    assert.equal((await call(s.url, 'POST', `/api/machines/${m.id}/approval`, { event: signed })).status, 200);
    // The same approval again: old counter.
    assert.equal((await call(s.url, 'POST', `/api/machines/${m.id}/approval`, { event: signed })).json.error, 'old counter');
    // Signed by someone else.
    const d2 = (await call(s.url, 'POST', `/api/machines/${m.id}/draft`, {})).json.event;
    assert.equal(d2.tags.find((t) => t[0] === 'counter')[1], '2');
    const forged = signEvent(d2, newSecretKey());
    assert.equal((await call(s.url, 'POST', `/api/machines/${m.id}/approval`, { event: forged })).json.error, 'unknown signer');
    // The machine fetches it; the card shows it waiting.
    const got = (await call(s.url, 'GET', `/api/agent/approval?m=${m.id}`)).json.approval;
    assert.equal(got.id, signed.id);
    let st = (await call(s.url, 'GET', '/api/state')).json.machines[0];
    assert.equal(st.approval.waiting, true);
    assert.ok(st.items.filter((i) => i.actionable).every((i) => i.queued));
    // The machine says it applied counter 1 and what happened.
    const at = new Date(s.clock.t).toISOString();
    await sendReport(s, m, {
      items: MAC_ITEMS.slice(1),
      lastCounter: 1,
      applied: [
        { at, how: 'click', channel: 'brew-formula', name: 'jq', title: 'jq', from: '1.7', to: '1.7.1', status: 'installed', message: '' },
        { at, how: 'click', channel: 'brew-cask', name: 'zoom', title: 'Zoom', from: '6.0.0', to: '6.1.0', status: 'needs-password', message: 'pkg installer' },
      ],
    });
    st = (await call(s.url, 'GET', '/api/state')).json;
    assert.equal(st.machines[0].approval.done, true);
    assert.deepEqual(st.log.map((e) => `${e.how} ${e.name} ${e.status}`).sort(), ['click jq installed', 'click zoom needs-password']);
    // The same applied list in the next report is not logged twice.
    await sendReport(s, m, { items: MAC_ITEMS.slice(1), lastCounter: 1, applied: [{ at, how: 'click', channel: 'brew-formula', name: 'jq', title: 'jq', from: '1.7', to: '1.7.1', status: 'installed', message: '' }] });
    assert.equal((await call(s.url, 'GET', '/api/state')).json.log.length, 2);
  }));

test('approve one item: only carries its id; unknown ids are refused', () =>
  withServer(async (s) => {
    const m = await joinMachine(s);
    await sendReport(s, m);
    assert.equal((await call(s.url, 'POST', `/api/machines/${m.id}/draft`, { only: ['nope'] })).status, 404);
    const id = itemId('brew-formula', 'jq');
    const d = (await call(s.url, 'POST', `/api/machines/${m.id}/draft`, { only: [id] })).json.event;
    assert.deepEqual(d.tags.find((t) => t[0] === 'only'), ['only', id]);
    assert.equal((await approve(s.url, m.id, [id])).status, 200);
  }));

test('windows approvals carry the ask-first list; dockge approvals the overrides', () =>
  withServer(async (s) => {
    const w = await joinMachine(s, 'windows');
    await call(s.url, 'POST', '/api/ask-first', { id: 'Valve.Steam', on: true });
    const ev = signEvent(reportTemplate({ machineId: w.id, os: 'windows', items: [{ channel: 'winget', name: 'Valve.Steam', current: '2', latest: '3', flags: {} }], createdAt: nowS(s) }), w.sk);
    await call(s.url, 'POST', '/api/agent/report', ev);
    const d = (await call(s.url, 'POST', `/api/machines/${w.id}/draft`, {})).json.event;
    const ask = d.tags.find((t) => t[0] === 'ask_first');
    assert.ok(ask.includes('Valve.Steam') && ask.includes('EclipseAdoptium.*'));
    assert.equal((await call(s.url, 'GET', '/api/state')).json.machines[0].items[0].askFirst, true);

    const dk = await joinMachine(s, 'dockge');
    const items = [
      { channel: 'dockge', name: 'dozzle', current: 'a', latest: 'b', flags: { update: true } },
      { channel: 'dockge', name: 'ditto-relay', current: '', latest: '', flags: { pinnedRef: true } },
      { channel: 'dockge', name: 'chronicle', current: 'a', latest: 'b', flags: { pinnedRef: true, update: true } },
      { channel: 'dockge', name: 'tube-agent', current: '', latest: '', flags: { local: true } },
    ];
    await call(s.url, 'POST', '/api/agent/report', signEvent(reportTemplate({ machineId: dk.id, os: 'dockge', items, createdAt: nowS(s) }), dk.sk));
    let m = (await call(s.url, 'GET', '/api/state')).json.machines[1];
    assert.deepEqual(m.items.filter((i) => i.actionable).map((i) => i.name), ['dozzle']);
    await call(s.url, 'POST', `/api/machines/${dk.id}/override`, { stack: 'chronicle', mode: 'compare' });
    m = (await call(s.url, 'GET', '/api/state')).json.machines[1];
    assert.deepEqual(m.items.filter((i) => i.actionable).map((i) => i.name), ['dozzle', 'chronicle']);
    const dd = (await call(s.url, 'POST', `/api/machines/${dk.id}/draft`, {})).json.event;
    assert.deepEqual(dd.tags.find((t) => t[0] === 'override'), ['override', 'chronicle', 'compare']);
  }));

test('two Dockge hosts are two cards with their own keys', () =>
  withServer(async (s) => {
    const x = await joinMachine(s, 'dockge', 'xumbrel Dockge');
    const a = await joinMachine(s, 'dockge', 'axial Dockge');
    const rep = (m, items) => call(s.url, 'POST', '/api/agent/report', signEvent(reportTemplate({ machineId: m.id, os: 'dockge', items, createdAt: nowS(s) }), m.sk));
    await rep(x, [{ channel: 'dockge', name: 'dozzle', current: 'a', latest: 'b', flags: { update: true } }]);
    await rep(a, [{ channel: 'dockge', name: 'miniflux', current: 'a', latest: 'b', flags: { update: true, majors: ['17'] } }]);
    const st = (await call(s.url, 'GET', '/api/state')).json;
    assert.deepEqual(st.machines.map((m) => [m.name, m.items[0].name]), [['xumbrel Dockge', 'dozzle'], ['axial Dockge', 'miniflux']]);
    await approve(s.url, a.id);
    assert.equal((await call(s.url, 'GET', `/api/agent/approval?m=${x.id}`)).json.approval, null);
    assert.ok((await call(s.url, 'GET', `/api/agent/approval?m=${a.id}`)).json.approval);
  }));

test('an uninstall report takes the card off; state and the dev key survive a restart', async () => {
  const s1 = await startServer();
  const m = await joinMachine(s1);
  const keep = await joinMachine(s1, 'linux');
  await s1.close();
  const s2 = await startServer({ dataDir: s1.dataDir });
  try {
    assert.equal(s2.app.signer.pubkey, s1.app.signer.pubkey);
    assert.equal((await sendReport(s2, m, { uninstall: true })).status, 200);
    const st = (await call(s2.url, 'GET', '/api/state')).json;
    assert.deepEqual(st.machines.map((x) => x.id), [keep.id]);
  } finally {
    await s2.close();
  }
});

test('without the dev flag there is no server-side signer', () =>
  withServer(
    async (s) => {
      assert.equal(s.app.signer.mode, 'external');
      assert.equal((await call(s.url, 'POST', '/api/dev/sign', { event: { kind: 31747, tags: [], created_at: 1 } })).status, 404);
    },
    { app: { devSigner: false, approverPubkey: publicKey(newSecretKey()) } }
  ));

// ---- Umbrels ----

function fakeUmbrel({ appsAfterUpdate, failure, sse = false } = {}) {
  const calls = [];
  const fixtures = Object.fromEntries(['list_apps', 'get_app_status', 'check_os_update', 'get_os_update_status', 'get_app_details'].map((n) => [n, JSON.parse(read(`umbrel/${n}.json`))]));
  let updated = false;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.authorization, method: body.method, tool: body.params?.name, args: body.params?.arguments });
    if (body.id === undefined) return new Response(null, { status: 202 });
    let result;
    if (body.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'umbrel' } };
    else {
      const name = body.params.name;
      let data = structuredClone(fixtures[name] ?? {});
      if (name === 'update_app') {
        updated = true;
        data = { ok: true };
      }
      if (name === 'get_app_status' && failure) data.lastOperationFailure = { message: failure };
      if (name === 'get_app_details' && updated && appsAfterUpdate) data.version = appsAfterUpdate;
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
    const msg = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    if (sse) return new Response(`event: message\ndata: ${msg}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' } });
    return new Response(msg, { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' } });
  };
  return { fetch, calls };
}

// Names the tailnet does not know fall back to DNS; here every name is 100.64.5.5.
const fakeLookup = async () => ({ address: '100.64.5.5', family: 4 });
const umbrelWith = (fake) => ({ app: { umbrel: createUmbrelAdapter({ fetch: fake.fetch, pollMs: 0, sleep: async () => {} }), lookup: fakeLookup } });

test('Umbrel card: app and umbrelOS updates from MCP; token kept server side only', async () => {
  const fake = fakeUmbrel({ sse: true });
  await withServer(async (s) => {
    const r = await call(s.url, 'POST', '/api/umbrels', { name: 'xumbrel', url: 'http://xumbrel.local/', token: 'secret-token-123' });
    assert.equal(r.status, 200);
    await s.app.idle();
    const st = (await call(s.url, 'GET', '/api/state')).json;
    const m = st.machines[0];
    assert.equal(m.address, 'http://100.64.5.5');
    assert.equal(m.addressName, 'xumbrel');
    assert.deepEqual(m.items.map((i) => i.name), ['lubelogger', 'keykin-box', 'umbrelos']);
    assert.ok(m.needs.some((n) => n.text === 'umbrelOS 2.0.2, restarts the Umbrel'));
    assert.ok(!JSON.stringify(st).includes('secret-token-123'));
    assert.equal(fake.calls[0].url, 'http://100.64.5.5/mcp');
    assert.equal(fake.calls[0].auth, 'Bearer secret-token-123');
    assert.equal((await call(s.url, 'POST', `/api/machines/${m.id}/draft`, {})).status, 409);
    // Update all leaves umbrelOS out.
    await call(s.url, 'POST', `/api/machines/${m.id}/update`, {});
    await s.app.idle();
    const updates = fake.calls.filter((c) => c.tool === 'update_app' || c.tool === 'install_os_update');
    assert.deepEqual(updates.map((c) => `${c.tool} ${c.args.appId || ''}`.trim()), ['update_app lubelogger', 'update_app keykin-box']);
  }, umbrelWith(fake));
});

test('Umbrel: an update that leaves the old version says so; failures show; real updates log versions', async () => {
  const fake = fakeUmbrel();
  await withServer(async (s) => {
    const r = await call(s.url, 'POST', '/api/umbrels', { name: 'ambrel', url: 'http://ambrel', token: 'secret-token-123' });
    await s.app.idle();
    const m = (await call(s.url, 'GET', '/api/state')).json.machines[0];
    const kb = m.items.find((i) => i.name === 'keykin-box');
    await call(s.url, 'POST', `/api/machines/${r.json.machine.id}/update`, { id: kb.id });
    await s.app.idle();
    const st = (await call(s.url, 'GET', '/api/state')).json;
    assert.equal(st.log[0].status, 'still-old');
    assert.ok(st.machines[0].needs.some((n) => n.text === 'Keykin Box still old, retry in a few minutes'));
  }, umbrelWith(fake));

  await withServer(async (s) => {
    await call(s.url, 'POST', '/api/umbrels', { name: 'ambrel', url: 'http://ambrel', token: 'secret-token-123' });
    await s.app.idle();
    const m = (await call(s.url, 'GET', '/api/state')).json.machines[0];
    assert.ok(m.needs.some((n) => n.text === 'Keykin Box: pull failed: manifest unknown'));
    // keykin-login has no update but is watched: it shows because of the failure, with no button.
    assert.ok(m.items.some((i) => i.name === 'keykin-login' && !i.actionable));
  }, umbrelWith(fakeUmbrel({ failure: 'pull failed: manifest unknown' })));

  await withServer(async (s) => {
    const r = await call(s.url, 'POST', '/api/umbrels', { name: 'x', url: 'http://x', token: 'secret-token-123' });
    await s.app.idle();
    const m = (await call(s.url, 'GET', '/api/state')).json.machines[0];
    await call(s.url, 'POST', `/api/machines/${r.json.machine.id}/update`, { id: m.items.find((i) => i.name === 'lubelogger').id });
    await s.app.idle();
    const log = (await call(s.url, 'GET', '/api/state')).json.log[0];
    assert.deepEqual([log.status, log.from, log.to], ['installed', '1.7.4', '1.7.5']);
  }, umbrelWith(fakeUmbrel({ appsAfterUpdate: '1.7.5' })));
});

test('Umbrel: a refused token shows on the card without the token', () =>
  withServer(
    async (s) => {
      await call(s.url, 'POST', '/api/umbrels', { name: 'x', url: 'http://x', token: 'secret-token-123' });
      await s.app.idle();
      const m = (await call(s.url, 'GET', '/api/state')).json.machines[0];
      assert.equal(m.needs[0].text, 'Not reachable: token refused');
    },
    { app: { umbrel: createUmbrelAdapter({ fetch: async () => new Response('', { status: 401 }), pollMs: 0, sleep: async () => {} }), lookup: fakeLookup } }
  ));

test('Umbrel card: accepts what Umbrel\'s Connect your agent screen shows', async () => {
  await withServer(async (s) => {
    // The whole "Any other AI agent" block pasted into the token field, no address, no name.
    const block = 'http://100.101.146.83/mcp\nAuthorization: Bearer umbrelmcp_cf03abcdef0123456789';
    let r = await call(s.url, 'POST', '/api/umbrels', { token: block });
    assert.equal(r.status, 200);
    assert.equal(r.json.machine.name, '100.101.146.83');
    // Just the header line, with an address that ends in /mcp.
    r = await call(s.url, 'POST', '/api/umbrels', { name: 'axial', url: 'http://100.97.142.86/mcp', token: 'Authorization: Bearer umbrelmcp_0123456789abcdef' });
    assert.equal(r.status, 200);
    // A token with a space in it still gets a readable error.
    r = await call(s.url, 'POST', '/api/umbrels', { name: 'x', url: 'http://100.1.2.3', token: 'not a token' });
    assert.equal(r.status, 400);
    assert.match(r.text, /umbrelmcp_/);
  });
});

// ---- tailnet names and found Umbrels ----

test('Umbrel by name: resolved through the tailnet an agent reported; stored by IP, shown by name', async () => {
  const fake = fakeUmbrel();
  await withServer(async (s) => {
    const mac = await joinMachine(s, 'mac', 'Mac');
    // Before any agent reports a tailnet, a name is not found; the error says what to do.
    let r = await call(s.url, 'POST', '/api/umbrels', { url: 'axial', token: 'umbrelmcp_0123456789abcdef' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'Could not find axial. Use its Tailscale IP (tailscale ip axial), or join a machine that runs Tailscale first.');
    assert.equal(r.json.needAddress, true);
    assert.equal((await sendReport(s, mac, { tailnet: TAILNET })).status, 200);
    for (const [url, n] of [['axial', 1], ['http://axial/mcp', 2], ['AXIAL.local', 3], ['https://axial.example-tailnet.ts.net/', 4]]) {
      r = await call(s.url, 'POST', '/api/umbrels', { url, token: 'umbrelmcp_0123456789abcdef' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.machine.name, 'axial');
      const m = (await call(s.url, 'GET', '/api/state')).json.machines.filter((x) => x.os === 'umbrel');
      assert.equal(m.length, n);
      assert.equal(m[n - 1].address, url.startsWith('https') ? 'https://100.64.0.17' : 'http://100.64.0.17');
      assert.equal(m[n - 1].addressName, 'axial');
    }
    await s.app.idle();
    assert.equal(fake.calls[0].url, 'http://100.64.0.17/mcp');
    // An IP on the tailnet gets its peer name.
    r = await call(s.url, 'POST', '/api/umbrels', { url: '100.64.0.18', token: 'umbrelmcp_0123456789abcdef' });
    assert.equal(r.json.machine.name, 'ambrel');
    // A name DNS turns into loopback is this container, not the Umbrel.
    r = await call(s.url, 'POST', '/api/umbrels', { url: 'nas', token: 'umbrelmcp_0123456789abcdef' });
    assert.match(r.json.error, /^Could not find nas\. /);
    r = await call(s.url, 'POST', '/api/umbrels', { url: 'http://127.0.0.1/mcp', token: 'umbrelmcp_0123456789abcdef' });
    assert.equal(r.status, 400);
    r = await call(s.url, 'POST', '/api/umbrels', { url: 'ftp://axial', token: 'umbrelmcp_0123456789abcdef' });
    assert.match(r.json.error, /does not look right/);
    // A report without the section (an old agent) is still accepted and the names go with it.
    assert.equal((await sendReport(s, mac, {}, nowS(s) + 1)).status, 200);
    r = await call(s.url, 'POST', '/api/umbrels', { url: 'axial', token: 'umbrelmcp_0123456789abcdef' });
    assert.equal(r.status, 400);
  }, { app: { umbrel: createUmbrelAdapter({ fetch: fake.fetch, pollMs: 0, sleep: async () => {} }), lookup: async (h) => ({ address: h === 'nas' ? '127.0.1.1' : '127.0.0.1' }) } });
});

test('Umbrel: the "send your agent this message" text alone is enough', async () => {
  const fake = fakeUmbrel();
  await withServer(async (s) => {
    const mac = await joinMachine(s, 'mac', 'Mac');
    await sendReport(s, mac, { tailnet: TAILNET });
    const text = read('umbrel/agent-message.txt');
    const r = await call(s.url, 'POST', '/api/umbrels', { token: text });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.machine.name, 'axial');
    await s.app.idle();
    assert.equal(fake.calls[0].url, 'http://100.64.0.17/mcp');
    assert.equal(fake.calls[0].auth, 'Bearer umbrelmcp_fake0123456789abcdefFAKE');
    const m = (await call(s.url, 'GET', '/api/state')).json.machines.find((x) => x.os === 'umbrel');
    assert.ok(m.items.length > 0);
    assert.ok(!JSON.stringify((await call(s.url, 'GET', '/api/state')).json).includes('umbrelmcp_'));
    // The same text with an address typed in: the typed address wins.
    const r2 = await call(s.url, 'POST', '/api/umbrels', { url: '100.64.0.18', token: text });
    assert.equal(r2.json.machine.name, 'ambrel');
    // Nothing pasted, or nothing usable.
    assert.equal((await call(s.url, 'POST', '/api/umbrels', { token: '' })).status, 400);
    const noAddr = await call(s.url, 'POST', '/api/umbrels', { token: 'umbrelmcp_0123456789abcdef' });
    assert.equal(noAddr.json.needAddress, true);
  }, umbrelWith(fake));
});

test('found on the tailnet: probes peers, lists Umbrels that are not cards yet', async () => {
  const r401 = readHttp('umbrel/mcp-401.txt');
  const probed = [];
  // axial and ambrel answer like the recorded Umbrel; the rest do not.
  const probeFetch = async (url) => {
    probed.push(url);
    if (/100\.64\.0\.1[78]\//.test(url)) return new Response(r401.body, { status: 401, headers: r401.headers });
    return new Response('<html>', { status: 200 });
  };
  const { probeUmbrel } = await import('../umbrel/discover.js');
  const fake = fakeUmbrel();
  await withServer(async (s) => {
    const mac = await joinMachine(s, 'mac', 'Mac');
    await sendReport(s, mac, { tailnet: TAILNET });
    await new Promise((r) => setImmediate(r));
    await s.app.findUmbrels();
    // Offline peers are not probed; only 100.x addresses, /mcp, no token.
    assert.ok(probed.every((u) => /^http:\/\/100\.64\.0\.\d+\/mcp$/.test(u)));
    assert.ok(!probed.includes('http://100.64.0.11/mcp'));
    let st = (await call(s.url, 'GET', '/api/state')).json;
    assert.deepEqual(st.found, [{ ip: '100.64.0.18', name: 'ambrel' }, { ip: '100.64.0.17', name: 'axial' }]);
    // Adding one takes it off the list at once.
    const r = await call(s.url, 'POST', '/api/umbrels', { url: '100.64.0.17', name: 'axial', token: 'Authorization: Bearer umbrelmcp_0123456789abcdef' });
    assert.equal(r.status, 200);
    st = (await call(s.url, 'GET', '/api/state')).json;
    assert.deepEqual(st.found, [{ ip: '100.64.0.18', name: 'ambrel' }]);
    // The next round does not probe what is already a card.
    probed.length = 0;
    await s.app.findUmbrels();
    assert.ok(!probed.includes('http://100.64.0.17/mcp'));
    assert.ok(probed.includes('http://100.64.0.18/mcp'));
    // An unchanged tailnet (online flips only) does not start a round.
    probed.length = 0;
    await sendReport(s, mac, { tailnet: { ...TAILNET, peers: TAILNET.peers.map((p) => ({ ...p })) } }, nowS(s) + 1);
    await new Promise((r) => setImmediate(r));
    await s.app.idle();
    assert.equal(probed.length, 0);
  }, { app: { umbrel: createUmbrelAdapter({ fetch: fake.fetch, pollMs: 0, sleep: async () => {} }), probe: (ip) => probeUmbrel(ip, { fetch: probeFetch }) } });
});
