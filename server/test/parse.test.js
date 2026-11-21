import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseEnvelope,
  parseBrewOutdated,
  parseBrewCasks,
  parseSoftwareUpdate,
  parseRunningApps,
  parseWinget,
  parseWindowsUpdate,
  parseFlatpak,
  parseRpmOstree,
  parseDockge,
  isPinnedRef,
  majorOf,
  imageTag,
  parseReport,
} from '../parse.js';

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');
const read = (p) => fs.readFileSync(path.join(fx, p), 'utf8');

test('envelope splits meta and sections', () => {
  const e = parseEnvelope('#fleet os mac\n#fleet host m1\n#fleet section a\nline 1\nline 2\n#fleet section b\nx\n');
  assert.equal(e.meta.os, 'mac');
  assert.equal(e.meta.host, 'm1');
  assert.equal(e.sections.a, 'line 1\nline 2');
  assert.equal(e.sections.b, 'x\n');
});

test('brew outdated v2: formulae and casks, pinned marked, warnings before the JSON ignored', () => {
  const items = parseBrewOutdated(read('mac/brew-outdated.json'));
  assert.equal(items.length, 6);
  const jq = items.find((i) => i.name === 'jq');
  assert.deepEqual([jq.channel, jq.current, jq.latest], ['brew-formula', '1.7', '1.7.1']);
  assert.equal(items.find((i) => i.name === 'node@20').flags.pinned, true);
  const ff = items.find((i) => i.name === 'firefox');
  assert.deepEqual([ff.channel, ff.current, ff.latest], ['brew-cask', '120.0', '121.0']);
  assert.deepEqual(parseBrewOutdated(''), []);
  assert.deepEqual(parseBrewOutdated('not json'), []);
});

test('brew cask info: pkg casks and app bundles', () => {
  const c = parseBrewCasks(read('mac/brew-casks.json'));
  assert.equal(c.zoom.pkg, true);
  assert.equal(c.firefox.pkg, false);
  assert.deepEqual(c.firefox.apps, ['Firefox.app']);
  assert.equal(c.firefox.title, 'Mozilla Firefox');
  assert.deepEqual(c['newapp'].apps, ['New App.app']);
});

test('softwareupdate -l: titles and restart', () => {
  const b = parseSoftwareUpdate(read('mac/softwareupdate.txt'));
  assert.equal(b.length, 2);
  assert.deepEqual(b[0], { channel: 'softwareupdate', title: 'macOS Tahoe 26.2', version: '26.2', restart: true });
  assert.equal(b[1].restart, false);
  assert.deepEqual(parseSoftwareUpdate('Software Update Tool\n\nNo new software available.\n'), []);
});

test('running apps: outer bundle names', () => {
  const s = parseRunningApps(read('mac/running'));
  assert.ok(s.has('Discord.app'));
  assert.ok(s.has('Rectangle.app'));
  assert.ok(!s.has('Firefox.app'));
});

test('winget table: progress chars, truncated names, < versions, explicit section', () => {
  const items = parseWinget(read('windows/winget.txt'));
  assert.deepEqual(
    items.map((i) => i.name),
    ['Discord.Discord', 'Microsoft.EdgeWebView2Runtime', 'EclipseAdoptium.Temurin.21.JDK', '7zip.7zip', 'Valve.Steam', 'Spotify.Spotify']
  );
  const d = items[0];
  assert.deepEqual([d.title, d.current, d.latest, d.source], ['Discord', '1.0.9001', '1.0.9002', 'winget']);
  assert.equal(items[2].title, 'Eclipse Temurin JDK with Hotspot 21.0');
  assert.equal(items[3].current, '< 23.01');
  assert.equal(items[3].title, '7-Zip 23.01 (x64)');
  assert.equal(items[5].flags.explicit, true);
  assert.equal(items[0].flags.explicit, undefined);
  assert.deepEqual(parseWinget('No installed package found matching input criteria.\n'), []);
});

test('winget table with CRLF line ends', () => {
  const items = parseWinget(read('windows/winget.txt').replace(/\n/g, '\r\n'));
  assert.equal(items.length, 6);
});

test('windows update and reboot pending badges', () => {
  const b = parseWindowsUpdate(read('windows/windows-update.txt'), '1');
  assert.equal(b[0].count, 2);
  assert.equal(b[1].reboot, true);
  assert.deepEqual(parseWindowsUpdate('', '0'), []);
});

test('flatpak: updates with installed versions, branch in the name', () => {
  const u = parseFlatpak(read('linux/flatpak-user-updates.txt'), read('linux/flatpak-user-list.txt'), 'user');
  assert.deepEqual(u[0], { channel: 'flatpak-user', name: 'org.mozilla.firefox//stable', title: 'org.mozilla.firefox', current: '120.0', latest: '121.0', flags: {} });
  const s = parseFlatpak(read('linux/flatpak-system-updates.txt'), read('linux/flatpak-system-list.txt'), 'system');
  assert.equal(s.length, 2);
  assert.equal(s[0].name, 'org.freedesktop.Platform//24.08');
  assert.equal(s[1].latest, '');
  // Header lines (from a terminal) are skipped.
  assert.equal(parseFlatpak('Application ID\tBranch\tVersion\norg.a.B\tstable\t2\n', '', 'user').length, 1);
});

test('rpm-ostree: staged deployment is a reboot badge', () => {
  const b = parseRpmOstree(read('linux/rpm-ostree.json'));
  assert.equal(b.length, 1);
  assert.equal(b[0].staged, true);
  assert.match(b[0].title, /43\.20261120/);
  const c = parseRpmOstree(JSON.stringify({ deployments: [{ booted: true }], 'cached-update': { version: '43.2' } }));
  assert.equal(c[0].title, 'System update 43.2');
  assert.deepEqual(parseRpmOstree(''), []);
});

test('pin detection', () => {
  const pinned = ['ditto:2.5', 'x/y:0.12.12', 'z:2026.7.2', 'tailscale/tailscale:v1.104.1', 'a:7.2-alpine', 'ghcr.io/s/c:sha-fc4319c', 'r@sha256:' + 'a'.repeat(64), 'ghcr.io/s/c:latest@sha256:' + 'b'.repeat(64)];
  const floating = ['redis', 'redis:latest', 'python:3', 'postgres:17', 'node:2-alpine', 'debian:12-slim', 'localhost:5000/app', 'localhost:5000/app:latest', 'x:stable', 'x:beta', 'x:deadbeef'];
  for (const r of pinned) assert.equal(isPinnedRef(r), true, r);
  for (const r of floating) assert.equal(isPinnedRef(r), false, r);
  assert.equal(majorOf('postgres:17'), '17');
  assert.equal(majorOf('python:3'), '3');
  assert.equal(majorOf('node:v20'), '20');
  assert.equal(majorOf('node:2-alpine'), null);
  assert.equal(majorOf('redis:7-alpine'), null);
  assert.equal(majorOf('x:2.5'), null);
  assert.equal(majorOf('x:latest'), null);
  assert.equal(majorOf('postgres:17@sha256:' + 'a'.repeat(64)), null);
  assert.equal(imageTag('localhost:5000/app'), 'latest');
  assert.equal(imageTag('localhost:5000/app:1'), '1');
});

function dockgeFixture() {
  const images = Object.fromEntries(read('dockge/images.tsv').trim().split('\n').map((l) => l.split('\t')));
  const services = read('dockge/containers.tsv')
    .trim()
    .split('\n')
    .map((l) => {
      const [stack, , svc, ref, img, state] = l.split('\t');
      return [stack, svc, ref, img, state, images[img] || '-'].join('\t');
    });
  services.push('mc\t-');
  const registry = read('dockge/registry.tsv').trim() + '\nlejianwen/rustdesk-api:latest\terror\tunauthorized';
  return { services: services.join('\n'), registry };
}

test('dockge: digest comparison per stack', () => {
  const { services, registry } = dockgeFixture();
  const items = Object.fromEntries(parseDockge(services, registry).map((i) => [i.name, i]));
  assert.equal(items.dozzle.flags.update, true);
  assert.equal(items.dozzle.current, 'aaaaaaaaaaaa');
  assert.equal(items.dozzle.latest, 'bbbbbbbbbbbb');
  assert.equal(items.chronicle.flags.pinnedRef, true);
  assert.equal(items.chronicle.flags.update, undefined);
  assert.equal(items['ditto-relay'].flags.pinnedRef, true);
  assert.equal(items['ditto-relay'].flags.update, undefined);
  assert.equal(items['media-helpers'].flags.update, undefined);
  assert.equal(items['media-helpers'].flags.pinnedRef, undefined);
  assert.equal(items['tube-agent'].flags.local, true);
  assert.equal(items.mc.flags.notRunning, true);
  assert.equal(items.nv2.flags.update, true);
  assert.deepEqual(items.nv2.services.map((s) => [s.service, s.update]), [['redis', false], ['app', true]]);
  assert.equal(items['rustdesk-api'].flags.checkFailed, true);
  assert.equal(items['rustdesk-api'].flags.update, undefined);
  // postgres:17 is pinned-major: compared, so a new 17.x digest is an update, labelled major 17.
  assert.equal(items.miniflux.flags.update, true);
  assert.equal(items.miniflux.flags.pinnedRef, undefined);
  assert.deepEqual(items.miniflux.flags.majors, ['17']);
  assert.deepEqual(items.miniflux.services.map((x) => [x.service, x.major, x.update]), [['miniflux', null, true], ['db', '17', true]]);
});

test('dockge: a pinned tag whose registry digest moved still says update, the server decides', () => {
  const d = 'sha256:' + '1'.repeat(64);
  const n = 'sha256:' + '2'.repeat(64);
  const items = parseDockge(`s\tapp\tx:2.5\timg\trunning\tx@${d}`, `x:2.5\t${n}`);
  assert.equal(items[0].flags.pinnedRef, true);
  assert.equal(items[0].flags.update, true);
});

test('whole Mac report: cask flags joined from info and ps', () => {
  const text = [
    '#fleet os mac',
    '#fleet host m',
    '#fleet section brew-outdated',
    read('mac/brew-outdated.json'),
    '#fleet section brew-casks',
    read('mac/brew-casks.json'),
    '#fleet section softwareupdate',
    read('mac/softwareupdate.txt'),
    '#fleet section running',
    read('mac/running'),
  ].join('\n');
  const r = parseReport(text);
  assert.equal(r.os, 'mac');
  const by = Object.fromEntries(r.items.map((i) => [i.name, i]));
  assert.equal(by.discord.flags.running, true);
  assert.deepEqual(by.discord.flags.apps, ['Discord.app']);
  assert.equal(by.zoom.flags.pkg, true);
  assert.equal(by.firefox.flags.running, undefined);
  assert.equal(by.firefox.title, 'Mozilla Firefox');
  assert.equal(r.badges.length, 2);
});
