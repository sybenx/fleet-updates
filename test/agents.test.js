// The Go agent against the Node server, in-process, with fixtures standing in for brew, flatpak,
// winget and docker. Reports signed in Go are verified by the server; approvals signed by the
// server's test signer are verified by the agent. Nothing is installed.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, call, approve, tmpDir } from '../server/test/helpers.js';
import { itemId, newSecretKey, publicKey } from '../server/protocol.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = path.join(root, 'test', 'fixtures');
const go = ['go', '/opt/homebrew/bin/go', '/usr/local/go/bin/go'].find((g) => spawnSync(g, ['version'], { stdio: 'ignore' }).status === 0);
const binDir = tmpDir('fleet-bin-');
const bin = path.join(binDir, 'fleet-agent');
const HOUR = 3600;

before(() => {
  if (!go) return;
  const r = spawnSync(go, ['build', '-o', bin, '.'], { cwd: path.join(root, 'agent'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
const skip = go ? false : 'Go is not installed';

function run(args, env, cmd = bin) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { PATH: process.env.PATH, HOME: env.HOME || tmpDir(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), 60000);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

async function withServer(fn) {
  const s = await startServer();
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

// A machine joined with the agent's own `join`.
async function joinAgent(s, osName, extra = {}) {
  const j = await call(s.url, 'POST', '/api/joins', { os: osName });
  const token = /t=([A-Za-z0-9_-]+)/.exec(j.json.command)?.[1] || /FLEET_JOIN: "([^"]+)"/.exec(j.json.command)[1];
  const state = tmpDir();
  const env = { FLEET_STATE_DIR: state, FLEET_OS: osName, ...extra };
  const r = await run(['join', '--url', s.url, '--approver', s.app.signer.pubkey, token], env);
  assert.equal(r.code, 0, r.err);
  const st = JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8'));
  return { env, state, id: st.machine_id };
}

const machine = async (s, id) => (await call(s.url, 'GET', '/api/state')).json.machines.find((m) => m.id === id);

test('join: wrong approver in the command is refused', { skip }, () =>
  withServer(async (s) => {
    const j = await call(s.url, 'POST', '/api/joins', { os: 'mac' });
    const token = /t=([A-Za-z0-9_-]+)/.exec(j.json.command)[1];
    const r = await run(['join', '--url', s.url, '--approver', publicKey(newSecretKey()), token], { FLEET_STATE_DIR: tmpDir(), FLEET_OS: 'mac' });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /approver key is not the one/);
  }));

test('Mac: Go-signed report is accepted; an approval signed by the server applies the agent’s own list', { skip }, () =>
  withServer(async (s) => {
    const a = await joinAgent(s, 'mac', { FLEET_FIXTURE_DIR: path.join(fx, 'mac'), FLEET_DRY_RUN: '1', FLEET_HOUR: '12' });
    let r = await run(['run'], a.env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /no overnight installs/);
    assert.ok(!r.out.includes('would run'));
    let m = await machine(s, a.id);
    assert.equal(m.items.length, 6);
    assert.equal(m.host.length > 0, true);

    // Update all.
    assert.equal((await approve(s.url, a.id)).status, 200);
    r = await run(['run'], a.env);
    assert.match(r.out, /approval 1: applying/);
    assert.match(r.out, /would run: brew upgrade --formula jq/);
    assert.match(r.out, /would run: brew upgrade --cask firefox/);
    assert.match(r.out, /would run: brew upgrade --cask newapp/);
    assert.match(r.out, /skip discord: Discord.app is running/);
    assert.match(r.out, /skip zoom: needs your password/);
    assert.ok(!r.out.includes('node@20'));
    assert.ok(!r.out.includes('greedy'));
    const log = (await call(s.url, 'GET', '/api/state')).json.log.map((e) => `${e.how} ${e.name} ${e.status}`).sort();
    assert.deepEqual(log, ['click discord quit-first', 'click firefox dry-run', 'click jq dry-run', 'click newapp dry-run', 'click zoom needs-password']);
    m = await machine(s, a.id);
    assert.equal(m.approval.done, true);

    // Replayed: the same approval again does nothing.
    r = await run(['run'], a.env);
    assert.ok(!r.out.includes('would run'), r.out);

    // One item.
    await approve(s.url, a.id, [itemId('brew-formula', 'jq')]);
    r = await run(['run'], a.env);
    assert.deepEqual(r.out.match(/would run: .*/g), ['would run: brew upgrade --formula jq']);
  }));

test('Mac: the report carries the tailnet (signed); the dashboard resolves an Umbrel name from it', { skip }, async () => {
  const s = await startServer({ app: { umbrel: { check: async () => ({ items: [], badges: [] }) } } });
  try {
    const a = await joinAgent(s, 'mac', { FLEET_FIXTURE_DIR: path.join(fx, 'mac'), FLEET_DRY_RUN: '1', FLEET_HOUR: '12' });
    const r = await run(['run'], a.env);
    assert.equal(r.code, 0, r.err);
    const u = await call(s.url, 'POST', '/api/umbrels', { token: 'http://axial/mcp\nAuthorization: Bearer umbrelmcp_0123456789abcdef' });
    assert.equal(u.status, 200, u.text);
    const m = (await call(s.url, 'GET', '/api/state')).json.machines.find((x) => x.os === 'umbrel');
    assert.deepEqual([m.name, m.address], ['axial', 'http://100.64.0.17']);
    // An agent without Tailscale (no fixture here) sends no section and is accepted all the same.
    const l = await joinAgent(s, 'linux', { FLEET_FIXTURE_DIR: path.join(fx, 'linux'), FLEET_DRY_RUN: '1', FLEET_HOUR: '12' });
    assert.equal((await run(['run'], l.env)).code, 0);
    assert.ok((await machine(s, l.id)).lastSeen);
  } finally {
    await s.close();
  }
});

test('Mac: approvals that do not fit are not used (changed report, expired, unknown signer)', { skip }, () =>
  withServer(async (s) => {
    const fix = tmpDir();
    for (const f of fs.readdirSync(path.join(fx, 'mac'))) if (f !== 'bin') fs.copyFileSync(path.join(fx, 'mac', f), path.join(fix, f));
    const a = await joinAgent(s, 'mac', { FLEET_FIXTURE_DIR: fix, FLEET_DRY_RUN: '1', FLEET_HOUR: '12', FLEET_FULL: '1' });
    await run(['run'], a.env);

    // The machine's list changed after the report the approval names.
    await approve(s.url, a.id);
    fs.writeFileSync(path.join(fix, 'brew-outdated.json'), fs.readFileSync(path.join(fx, 'mac/brew-outdated.json'), 'utf8').replace('"1.7.1"', '"1.7.2"'));
    let r = await run(['run'], a.env);
    assert.match(r.out, /approval not used: report changed/);
    assert.ok(!r.out.includes('would run'));

    // Expired: a day and an hour later by the machine's clock.
    await approve(s.url, a.id);
    r = await run(['run'], { ...a.env, FLEET_NOW: String(Math.floor(Date.now() / 1000) + 25 * HOUR) });
    assert.match(r.out, /approval not used: expired/);
    assert.ok(!r.out.includes('would run'));

    // The machine trusts another approver.
    const st = JSON.parse(fs.readFileSync(path.join(a.state, 'state.json'), 'utf8'));
    fs.writeFileSync(path.join(a.state, 'state.json'), JSON.stringify({ ...st, approver: publicKey(newSecretKey()) }));
    r = await run(['run'], a.env);
    assert.match(r.out, /approval not used: unknown signer/);
    assert.ok(!r.out.includes('would run'));
  }));

test('Mac: overnight rules (2 day casks, not running, not .pkg); a stand-in brew sees only plain upgrades', { skip }, async () => {
  const t0 = Math.floor(Date.now() / 1000);
  const s = await startServer({ t: t0 * 1000 });
  try {
    const brewLog = path.join(tmpDir(), 'brew.log');
    const a = await joinAgent(s, 'mac', { FLEET_FIXTURE_DIR: path.join(fx, 'mac'), FLEET_FULL: '1', PATH: `${path.join(fx, 'mac/bin')}:${process.env.PATH}`, FAKE_BREW_LOG: brewLog });
    // First sight at 03:00: formulae only, casks are new.
    await run(['run'], { ...a.env, FLEET_HOUR: '3', FLEET_NOW: String(t0) });
    assert.deepEqual(fs.readFileSync(brewLog, 'utf8').trim().split('\n'), ['upgrade --formula jq']);
    // Two days later at 03:00: firefox and newapp too; discord runs, zoom is .pkg, node@20 is pinned.
    fs.writeFileSync(brewLog, '');
    s.clock.t = (t0 + 49 * HOUR) * 1000;
    await run(['run'], { ...a.env, FLEET_HOUR: '3', FLEET_NOW: String(t0 + 49 * HOUR) });
    assert.deepEqual(fs.readFileSync(brewLog, 'utf8').trim().split('\n').sort(), ['upgrade --cask firefox', 'upgrade --cask newapp', 'upgrade --formula jq']);
    const log = (await call(s.url, 'GET', '/api/state')).json.log.filter((e) => e.how === 'overnight').map((e) => `${e.name} ${e.status}`).sort();
    // jq twice: the fixtures still list it after the first night (a real brew would not).
    assert.deepEqual(log, ['firefox installed', 'jq installed', 'jq installed', 'newapp installed']);
    // Midday: nothing.
    fs.writeFileSync(brewLog, '');
    await run(['run'], { ...a.env, FLEET_HOUR: '13', FLEET_NOW: String(t0 + 50 * HOUR) });
    assert.equal(fs.readFileSync(brewLog, 'utf8'), '');
  } finally {
    await s.close();
  }
});

test('Linux: flatpak overnight, rpm-ostree badge only, nothing while a game runs', { skip }, () =>
  withServer(async (s) => {
    const a = await joinAgent(s, 'linux', { FLEET_FIXTURE_DIR: path.join(fx, 'linux'), FLEET_DRY_RUN: '1', FLEET_HOUR: '2', FLEET_FULL: '1' });
    let r = await run(['run'], a.env);
    assert.equal(r.code, 0, r.err);
    assert.equal((r.out.match(/would run: flatpak update/g) || []).length, 4);
    assert.match(r.out, /flatpak update --user -y --noninteractive org.mozilla.firefox\/\/stable/);
    assert.match(r.out, /flatpak update --system -y --noninteractive org.freedesktop.Platform\/\/24.08/);
    assert.ok(!/rpm-ostree (upgrade|update)/.test(r.out));
    const m = await machine(s, a.id);
    assert.ok(m.needs.some((n) => /Reboot to finish System update 43\.20261120/.test(n.text)));

    const gameFix = tmpDir();
    for (const f of fs.readdirSync(path.join(fx, 'linux'))) fs.copyFileSync(path.join(fx, 'linux', f), path.join(gameFix, f));
    fs.appendFileSync(path.join(gameFix, 'processes'), '/home/deck/.local/share/Steam/steamapps/common/Celeste/Celeste\n');
    r = await run(['run'], { ...a.env, FLEET_FIXTURE_DIR: gameFix });
    assert.equal((r.out.match(/a game is running/g) || []).length, 4);
    assert.ok(!r.out.includes('would run'));
  }));

test('Windows: winget overnight skips ask-first and explicit; a click can take them; policy comes signed', { skip }, () =>
  withServer(async (s) => {
    const a = await joinAgent(s, 'windows', { FLEET_FIXTURE_DIR: path.join(fx, 'windows'), FLEET_DRY_RUN: '1', FLEET_HOUR: '3', FLEET_FULL: '1' });
    let r = await run(['run'], a.env);
    assert.equal(r.code, 0, r.err);
    const ids = (out) => (out.match(/winget upgrade --id (\S+) --exact --silent --accept-source-agreements --accept-package-agreements/g) || []).map((x) => x.split(' ')[3]).sort();
    assert.deepEqual(ids(r.out), ['7zip.7zip', 'Discord.Discord', 'Microsoft.EdgeWebView2Runtime', 'Valve.Steam']);
    // Ask first for Steam: carried by the next approval (here one for Spotify).
    await call(s.url, 'POST', '/api/ask-first', { id: 'Valve.Steam', on: true });
    await approve(s.url, a.id, [itemId('winget', 'Spotify.Spotify')]);
    r = await run(['run'], a.env);
    assert.deepEqual(ids(r.out), ['7zip.7zip', 'Discord.Discord', 'Microsoft.EdgeWebView2Runtime', 'Spotify.Spotify']);
    // A Minecraft client running: nothing.
    const gameFix = tmpDir();
    for (const f of fs.readdirSync(path.join(fx, 'windows'))) fs.copyFileSync(path.join(fx, 'windows', f), path.join(gameFix, f));
    fs.appendFileSync(path.join(gameFix, 'processes.txt'), 'javaw\tC:\\Program Files\\Java\\bin\\javaw.exe\tjavaw -cp x net.minecraft.client.main.Main --accessToken y\n');
    r = await run(['run'], { ...a.env, FLEET_FIXTURE_DIR: gameFix });
    assert.ok(!r.out.includes('would run'), r.out);
  }));

test('Dockge: joins from its env, compares digests, never overnight; an approval updates only approved stacks', { skip }, () =>
  withServer(async (s) => {
    const j = await call(s.url, 'POST', '/api/joins', { os: 'dockge', name: 'axial Dockge' });
    const stacks = tmpDir();
    for (const name of ['dozzle', 'chronicle', 'ditto-relay', 'media-helpers', 'miniflux', 'tube-agent', 'nv2', 'rustdesk-api', 'mc']) {
      fs.mkdirSync(path.join(stacks, name));
      fs.writeFileSync(path.join(stacks, name, 'compose.yaml'), 'services: {}\n');
    }
    fs.mkdirSync(path.join(stacks, 'not-a-stack'));
    const dockerDir = tmpDir();
    for (const f of ['containers.tsv', 'images.tsv', 'registry.tsv']) fs.copyFileSync(path.join(fx, 'dockge', f), path.join(dockerDir, f));
    const env = {
      PATH: `${path.join(fx, 'dockge/bin')}:${process.env.PATH}`,
      FAKE_DOCKER_DIR: dockerDir,
      FLEET_URL: s.url,
      FLEET_JOIN: /FLEET_JOIN: "([^"]+)"/.exec(j.json.command)[1],
      FLEET_APPROVER: s.app.signer.pubkey,
      FLEET_STACKS_DIR: stacks,
      FLEET_STATE_DIR: tmpDir(),
      FLEET_HOUR: '3',
    };
    let r = await run(['dockge', '--once'], env);
    assert.equal(r.code, 0, r.err);
    const id = (await call(s.url, 'GET', '/api/state')).json.machines[0].id;
    let m = await machine(s, id);
    assert.equal(m.name, 'axial Dockge');
    assert.deepEqual(m.items.map((i) => i.name), ['chronicle', 'ditto-relay', 'dozzle', 'mc', 'media-helpers', 'miniflux', 'nv2', 'rustdesk-api', 'tube-agent']);
    assert.deepEqual(m.items.filter((i) => i.actionable).map((i) => i.name), ['dozzle', 'miniflux', 'nv2']);
    assert.deepEqual(m.items.find((i) => i.name === 'miniflux').flags.majors, ['17']);
    const calls = fs.readFileSync(path.join(dockerDir, 'calls.log'), 'utf8');
    assert.ok(!/\bpull\b/.test(calls));
    assert.ok(!calls.includes('imagetools inspect ghcr.io/sybenx/chronicle'));
    assert.ok(!calls.includes('imagetools inspect tube-agent'));
    assert.ok(!fs.existsSync(path.join(dockerDir, 'compose.log')));

    // Approve nv2 only, dry run.
    await approve(s.url, id, [itemId('dockge', 'nv2')]);
    r = await run(['dockge', '--once', '--dry-run'], env);
    assert.deepEqual(r.out.match(/would run in .*/g), [`would run in ${path.join(stacks, 'nv2')}: docker compose pull && docker compose up -d`]);
    // Approve all, for real against the stand-in docker.
    await approve(s.url, id);
    r = await run(['dockge', '--once'], env);
    assert.equal(r.code, 0, r.err);
    const compose = fs.readFileSync(path.join(dockerDir, 'compose.log'), 'utf8').trim().split('\n');
    const dirs = compose.map((l) => l.replace(/^compose compose (pull --quiet|up -d) in /, '')).map((d) => path.basename(d));
    assert.deepEqual([...new Set(dirs)].sort(), ['dozzle', 'miniflux', 'nv2']);
    assert.equal(compose.length, 6);
  }));

const hostBin = { 'darwin-arm64': 'fleet-agent-darwin-arm64', 'linux-x64': 'fleet-agent-linux-amd64' }[`${os.platform()}-${os.arch()}`];
test('install flow: the page command downloads the agent, checks its sha256, joins; uninstall takes the card off', { skip: !go ? 'Go is not installed' : !hostBin ? 'no agent build for this host' : false }, async () => {
  const dist = tmpDir();
  fs.copyFileSync(bin, path.join(dist, hostBin));
  const s = await startServer({ app: { distDir: dist } });
  try {
    const osName = os.platform() === 'darwin' ? 'mac' : 'linux';
    const j = await call(s.url, 'POST', '/api/joins', { os: osName, name: 'Test machine' });
    const home = tmpDir();
    // The command exactly as the page shows it, with launchd/systemd left alone.
    let r = await run(['-c', j.json.command], { HOME: home, FLEET_INSTALL_NO_LOAD: '1' }, '/bin/sh');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /joined as machine/);
    const installed = osName === 'mac' ? path.join(home, 'Library/Application Support/FleetAgent/fleet-agent') : path.join(home, '.local/share/fleet-agent/fleet-agent');
    assert.ok(fs.existsSync(installed));
    if (osName === 'mac') {
      const plist = fs.readFileSync(path.join(home, 'Library/LaunchAgents/cc.aaro.fleet-agent.plist'), 'utf8');
      assert.ok(plist.includes(`<string>${installed}</string>`) && plist.includes('<string>run</string>'));
      if (fs.existsSync('/usr/bin/plutil')) assert.equal(spawnSync('/usr/bin/plutil', ['-lint', path.join(home, 'Library/LaunchAgents/cc.aaro.fleet-agent.plist')]).status, 0);
    }
    // The installed agent runs (dry, fixtures) and reports.
    r = await run(['run'], { HOME: home, FLEET_OS: 'mac', FLEET_FIXTURE_DIR: path.join(fx, 'mac'), FLEET_DRY_RUN: '1', FLEET_HOUR: '12', ...(osName === 'linux' ? { FLEET_STATE_DIR: path.join(home, '.local/state/fleet-agent') } : {}) }, installed);
    assert.equal(r.code, 0, r.err);
    let st = (await call(s.url, 'GET', '/api/state')).json;
    assert.equal(st.machines[0].name, 'Test machine');
    assert.equal(st.machines[0].items.length, 6);
    // Used command: refused.
    r = await run(['-c', j.json.command], { HOME: tmpDir(), FLEET_INSTALL_NO_LOAD: '1' }, '/bin/sh');
    assert.notEqual(r.code, 0);
    // Uninstall.
    r = await run(['-c', st.machines[0].uninstall], { HOME: home, FLEET_INSTALL_NO_LOAD: '1', ...(osName === 'linux' ? { FLEET_STATE_DIR: path.join(home, '.local/state/fleet-agent') } : {}) }, '/bin/sh');
    assert.equal(r.code, 0, r.err);
    st = (await call(s.url, 'GET', '/api/state')).json;
    assert.equal(st.machines.length, 0);
    assert.ok(!fs.existsSync(installed));
  } finally {
    await s.close();
  }
});

test('install flow: a binary that does not match its sha256 is not installed', { skip: !hostBin ? 'no agent build for this host' : false }, async () => {
  const dist = tmpDir();
  fs.writeFileSync(path.join(dist, hostBin), 'not the agent');
  const s = await startServer({ app: { distDir: dist } });
  try {
    const osName = os.platform() === 'darwin' ? 'mac' : 'linux';
    const j = await call(s.url, 'POST', '/api/joins', { os: osName });
    const home = tmpDir();
    // Point the hash check at another file's sha256, as if the download had been swapped.
    const script = await (await fetch(/'(http[^']+)'/.exec(j.json.command)[1])).text();
    const tampered = script.replace(/\$URL\/api\/agent\/bin\/\$BIN\.sha256/, `${s.url}/api/agent/bin/fleet-agent-windows-amd64.exe.sha256`);
    fs.writeFileSync(path.join(dist, 'fleet-agent-windows-amd64.exe'), 'something else');
    const r = await run(['-c', tampered], { HOME: home, FLEET_INSTALL_NO_LOAD: '1' }, '/bin/sh');
    assert.notEqual(r.code, 0);
    assert.match(r.err, /does not match its sha256/);
    assert.ok(!fs.existsSync(path.join(home, 'Library/Application Support/FleetAgent/fleet-agent')));
  } finally {
    await s.close();
  }
});
