// The Go agent's parsers and server/parse.js read the same fixtures the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseBrewOutdated, parseBrewCasks, parseRunningApps, parseSoftwareUpdate, parseWinget, parseWindowsUpdate, parseFlatpak, parseRpmOstree, parseDockge } from '../server/parse.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = (p) => path.join(root, 'test', 'fixtures', p);
const read = (p) => fs.readFileSync(fx(p), 'utf8');
const go = ['go', '/opt/homebrew/bin/go', '/usr/local/go/bin/go'].find((g) => spawnSync(g, ['version'], { stdio: 'ignore' }).status === 0);
const skip = go ? false : 'Go is not installed';

function goParse(kind, ...files) {
  const r = spawnSync(go, ['run', '.', 'parse', kind, ...files.map(fx)], { cwd: path.join(root, 'agent'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// Go leaves out empty and false fields; JSON round trip of the JS side does the same here.
function norm(items) {
  const clean = (v) => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        if (x === false || x === undefined || x === null || x === '' || (Array.isArray(x) && !x.length)) continue;
        o[k] = clean(x);
      }
      return o;
    }
    return v;
  };
  return clean(JSON.parse(JSON.stringify(items)));
}

function jsMac() {
  const casks = parseBrewCasks(read('mac/brew-casks.json'));
  const running = parseRunningApps(read('mac/running'));
  return parseBrewOutdated(read('mac/brew-outdated.json')).map((it) => {
    const info = casks[it.name];
    if (it.channel === 'brew-cask' && info) {
      it.title = info.title;
      if (info.pkg) it.flags.pkg = true;
      if (info.apps.length) it.flags.apps = info.apps;
      if (info.apps.some((a) => running.has(a))) it.flags.running = true;
    }
    return it;
  });
}

test('mac: Go and JS agree', { skip }, () => {
  assert.deepEqual(norm(goParse('mac', 'mac/brew-outdated.json', 'mac/brew-casks.json', 'mac/running')), norm(jsMac()));
  assert.deepEqual(norm(goParse('softwareupdate', 'mac/softwareupdate.txt')), norm(parseSoftwareUpdate(read('mac/softwareupdate.txt'))));
});

test('winget and Windows Update: Go and JS agree', { skip }, () => {
  assert.deepEqual(norm(goParse('winget', 'windows/winget.txt')), norm(parseWinget(read('windows/winget.txt'))));
  assert.deepEqual(norm(goParse('windows-update', 'windows/windows-update.txt', 'windows/reboot-pending.txt')), norm(parseWindowsUpdate(read('windows/windows-update.txt'), read('windows/reboot-pending.txt'))));
});

test('flatpak and rpm-ostree: Go and JS agree', { skip }, () => {
  for (const scope of ['user', 'system'])
    assert.deepEqual(norm(goParse(`flatpak-${scope}`, `linux/flatpak-${scope}-updates.txt`, `linux/flatpak-${scope}-list.txt`)), norm(parseFlatpak(read(`linux/flatpak-${scope}-updates.txt`), read(`linux/flatpak-${scope}-list.txt`), scope)));
  assert.deepEqual(norm(goParse('rpm-ostree', 'linux/rpm-ostree.json')), norm(parseRpmOstree(read('linux/rpm-ostree.json'))));
});

test('dockge: Go and JS agree', { skip }, () => {
  const images = Object.fromEntries(read('dockge/images.tsv').trim().split('\n').map((l) => l.split('\t')));
  const services = read('dockge/containers.tsv').trim().split('\n').map((l) => {
    const [stack, , svc, ref, img, state] = l.split('\t');
    return [stack, svc, ref, img, state, images[img] || '-'].join('\t');
  });
  services.push('mc\t-');
  const dir = fs.mkdtempSync(path.join(root, 'test', 'fixtures', '.tmp-'));
  try {
    fs.writeFileSync(path.join(dir, 's'), services.join('\n'));
    fs.writeFileSync(path.join(dir, 'r'), read('dockge/registry.tsv') + 'lejianwen/rustdesk-api:latest\terror\tunauthorized\n');
    const rel = path.relative(path.join(root, 'test', 'fixtures'), dir);
    assert.deepEqual(norm(goParse('dockge', `${rel}/s`, `${rel}/r`)), norm(parseDockge(services.join('\n'), fs.readFileSync(path.join(dir, 'r'), 'utf8'))));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
