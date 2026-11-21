import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { APPROVAL_TTL_S, acceptApproval, approvalFields, approvalTemplate, itemId, readReport, tag } from './protocol.js';
import { actionable, inUpdateAll, itemKey, matchesAskFirst, needsList, stackPinned } from './policy.js';
import { createSigner } from './signer.js';
import { createUmbrelAdapter } from './umbrel/adapter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT_OSES = ['mac', 'windows', 'linux', 'dockge'];
const JOIN_MS = 3600 * 1000;
const CATCHES = {
  mac: 'App Store apps are not covered: mas is not installed.',
  windows: 'Needs an admin PowerShell.',
  linux: 'System flatpaks and rpm-ostree may need one sudo step for polkit; the installer prints it.',
  dockge: 'Paste into Dockge as a new stack and Deploy.',
};
const AGENT_FILES = {
  mac: ['install.sh', 'uninstall.sh', 'cc.aaro.fleet-agent.plist'],
  linux: ['install.sh', 'uninstall.sh', 'fleet-agent.service', 'fleet-agent.timer'],
  windows: ['install.ps1', 'uninstall.ps1'],
  dockge: ['compose.yaml'],
};
// The agent binaries the install scripts download, from DIST_DIR (built by scripts/build-agents.sh).
const BINARIES = ['fleet-agent-darwin-arm64', 'fleet-agent-linux-amd64', 'fleet-agent-windows-amd64.exe'];
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/signer.js': ['signer.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const LOG_MAX = 2000;
const MAX_BODY = 8 * 1024 * 1024;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newId = (n = 8) => crypto.randomBytes(n).toString('hex');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp({
  dataDir,
  agentsDir = path.join(here, '..', 'agents'),
  distDir = path.join(here, '..', 'dist'),
  publicUrl = '',
  now = () => Date.now(),
  umbrel = createUmbrelAdapter(),
  devSigner = false,
  approverPubkey = '',
} = {}) {
  const store = openStore(dataDir);
  const S = () => store.state;
  const iso = () => new Date(now()).toISOString();
  const nowS = () => Math.floor(now() / 1000);
  const signer = createSigner({ dataDir, dev: devSigner, approverPubkey });
  const approver = () => signer.pubkey;

  function baseUrl(req) {
    if (publicUrl) return publicUrl.replace(/\/+$/, '');
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto}://${req.headers.host || 'localhost'}`;
  }

  // ---- joining ----

  function installCommand(os, url, join) {
    if (os === 'windows') return `$env:FLEET_APPROVER='${approver()}'; irm '${url}/install/windows?t=${join}' | iex`;
    if (os === 'dockge') {
      const tpl = fs.readFileSync(path.join(agentsDir, 'dockge', 'compose.yaml'), 'utf8');
      return tpl.replaceAll('__FLEET_URL__', url).replaceAll('__FLEET_JOIN__', join).replaceAll('__FLEET_APPROVER__', approver());
    }
    return `curl -fsSL '${url}/install/${os}?t=${join}' | FLEET_APPROVER=${approver()} sh`;
  }

  function uninstallCommand(os, url) {
    if (os === 'windows') return `irm '${url}/install/windows/uninstall' | iex`;
    if (os === 'mac' || os === 'linux') return `curl -fsSL '${url}/install/${os}/uninstall' | sh`;
    return '';
  }

  function validJoin(join) {
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(join || '')) return null;
    const h = sha256(join);
    const j = (S().joins || []).find((x) => x.hash === h);
    if (!j || j.usedAt || now() > Date.parse(j.expiresAt)) return null;
    return j;
  }

  function createJoin(body, req) {
    const os = String(body.os || '');
    if (!AGENT_OSES.includes(os)) throw new HttpError(400, 'os');
    if (!approver()) throw new HttpError(409, 'no approver key set');
    const name = String(body.name || '').trim().slice(0, 60);
    const join = crypto.randomBytes(18).toString('base64url');
    const st = S();
    st.joins = (st.joins || []).filter((j) => now() - Date.parse(j.expiresAt) < 24 * 3600 * 1000);
    const expiresAt = new Date(now() + JOIN_MS).toISOString();
    st.joins.push({ hash: sha256(join), os, name, expiresAt, usedAt: null });
    store.save();
    return { command: installCommand(os, baseUrl(req), join), expiresAt, catch: CATCHES[os] };
  }

  // The install script for /install/<os>: the server address and join token, then the installer.
  function installScript(os, url, join) {
    const body = fs.readFileSync(path.join(agentsDir, os, os === 'windows' ? 'install.ps1' : 'install.sh'), 'utf8');
    const ok = validJoin(join);
    if (os === 'windows') {
      if (!ok) return "Write-Error 'This install command has expired or was used. Make a new one on the page.'\n";
      return `$FleetUrl = '${url}'\n$FleetJoin = '${join}'\n${body}`;
    }
    if (!ok) return "#!/bin/sh\necho 'This install command has expired or was used. Make a new one on the page.' >&2\nexit 1\n";
    return body.replace(/^#!\/bin\/sh\n/, `#!/bin/sh\nFLEET_URL='${url}'\nFLEET_JOIN='${join}'\n`);
  }

  // A machine trades the join token for its place on the page, giving the public key it made.
  // From then on the dashboard accepts reports signed by that key and no other.
  function register(body) {
    const j = validJoin(body.join);
    if (!j) throw new HttpError(403, 'join token expired or used');
    const pubkey = String(body.pubkey || '');
    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new HttpError(400, 'pubkey');
    if (Object.values(S().machines).some((m) => m.pubkey === pubkey)) throw new HttpError(409, 'key already added');
    j.usedAt = iso();
    const host = String(body.host || '').replace(/[^\w .-]/g, '').slice(0, 60);
    const machine = newMachine(j.name || host || j.os, j.os);
    machine.pubkey = pubkey;
    machine.host = host;
    store.save();
    return { machine: machine.id, approver: approver() };
  }

  function newMachine(name, os) {
    const machine = { id: newId(4), name, os, pubkey: '', createdAt: iso(), lastSeen: null, items: [], badges: [], lastResults: {}, overrides: {}, approval: null, approvalCounter: 0 };
    S().machines[machine.id] = machine;
    return machine;
  }

  function removeMachine(machine) {
    delete S().machines[machine.id];
    S().jobs = S().jobs.filter((j) => j.machineId !== machine.id);
    store.save();
  }

  function machineById(id) {
    const m = S().machines[id];
    if (!m) throw new HttpError(404, 'no such machine');
    return m;
  }

  // ---- reports and approvals ----

  function log(machine, how, it, status, message, at) {
    S().log.push({
      at: at || iso(),
      machineId: machine.id,
      machine: machine.name,
      how,
      channel: it.channel,
      name: it.name,
      title: it.title || it.name,
      from: it.from ?? it.current ?? '',
      to: it.to ?? it.latest ?? '',
      status,
      message: message || '',
    });
    if (S().log.length > LOG_MAX) S().log.splice(0, S().log.length - LOG_MAX);
  }

  function report(ev) {
    const machine = Object.values(S().machines).find((m) => m.pubkey && ev && m.pubkey === ev.pubkey);
    if (!machine) throw new HttpError(403, 'unknown machine key');
    const r = readReport(ev, { now: nowS() });
    if (!r.ok) throw new HttpError(400, r.reason);
    if (r.machineId !== machine.id) throw new HttpError(403, 'report for another machine');
    if (machine.reportAt && ev.created_at < machine.reportCreatedAt) return { ok: true, stale: true, approval: machine.approval };
    const p = r.payload;
    if (p.uninstall) {
      removeMachine(machine);
      return { ok: true, removed: true };
    }
    // A report is a full snapshot: it replaces what was there.
    machine.host = String(p.host || machine.host || '').slice(0, 60);
    machine.items = p.items;
    machine.badges = Array.isArray(p.badges) ? p.badges : [];
    machine.reportHash = r.hash;
    machine.reportAt = iso();
    machine.reportCreatedAt = ev.created_at;
    machine.lastSeen = iso();
    machine.lastCounter = Number(p.last_counter) || 0;
    // What the machine says it applied, logged once each.
    machine.logged ||= [];
    const seen = new Set(machine.logged);
    machine.lastResults = {};
    for (const a of Array.isArray(p.applied) ? p.applied : []) {
      const key = `${a.at}|${a.channel}|${a.name}|${a.status}`;
      if (a.status !== 'installed') machine.lastResults[itemKey(a)] = { status: a.status, message: a.message || '', at: a.at };
      if (seen.has(key) || a.status === 'game-running') continue;
      seen.add(key);
      machine.logged.push(key);
      log(machine, a.how === 'overnight' ? 'overnight' : 'click', a, a.status, a.message, a.at);
    }
    const keys = new Set(machine.items.map(itemKey));
    for (const k of Object.keys(machine.lastResults)) if (!keys.has(k)) delete machine.lastResults[k];
    if (machine.logged.length > 500) machine.logged = machine.logged.slice(-500);
    store.save();
    return { ok: true, approval: machine.approval };
  }

  // The unsigned approval for the page to hand to its signer.
  function draft(machine, body) {
    if (machine.os === 'umbrel') throw new HttpError(409, 'Umbrels update by click');
    if (!machine.reportHash) throw new HttpError(409, 'no report yet');
    const ids = new Map((machine.items || []).filter((it) => actionable(it, machine) && inUpdateAll(it)).map((it) => [itemId(it.channel, it.name), it]));
    let only = [];
    if (Array.isArray(body.only) && body.only.length) {
      only = body.only.map(String).filter((id) => [...(machine.items || [])].some((it) => itemId(it.channel, it.name) === id && actionable(it, machine)));
      if (!only.length) throw new HttpError(404, 'no such update');
    } else if (!ids.size) throw new HttpError(409, 'nothing to update');
    const counter = Math.max(machine.approvalCounter || 0, machine.lastCounter || 0) + 1;
    return approvalTemplate({
      machineId: machine.id,
      reportHash: machine.reportHash,
      counter,
      now: nowS(),
      ttl: APPROVAL_TTL_S,
      only,
      overrides: machine.os === 'dockge' ? machine.overrides || {} : {},
      askFirst: machine.os === 'windows' ? S().askFirst : [],
    });
  }

  function storeApproval(machine, ev) {
    const r = acceptApproval(ev, { approver: approver(), machineId: machine.id, storedCounter: machine.approvalCounter || 0, now: nowS() });
    if (!r.ok) throw new HttpError(400, r.reason);
    machine.approval = ev;
    machine.approvalCounter = r.counter;
    store.save();
    return { ok: true };
  }

  function approvalView(machine) {
    const ev = machine.approval;
    if (!ev) return null;
    const f = approvalFields(ev);
    const done = (machine.lastCounter || 0) >= f.counter;
    const expired = nowS() >= f.expiration;
    return {
      counter: f.counter,
      expiresAt: new Date(f.expiration * 1000).toISOString(),
      only: f.only,
      waiting: !done && !expired && f.report === machine.reportHash,
      stale: !done && !expired && f.report !== machine.reportHash,
      done,
      expired,
    };
  }

  // ---- Umbrels: the server talks to them itself; there is no agent ----

  // Accepts what Umbrel's "Connect your agent" screen shows: the bare token, the
  // "Authorization: Bearer ..." line, or the whole block (address and header). The address may
  // end in /mcp.
  function umbrelConfig(body) {
    const pasted = String(body.token || '');
    let url = String(body.url || '').trim();
    if (!url) url = (pasted.match(/https?:\/\/[^\s"']+/) || [''])[0];
    url = url.replace(/\/+$/, '').replace(/\/mcp$/, '');
    if (url && !/^https?:\/\/[\w.:[\]-]+$/.test(url)) throw new HttpError(400, 'That address does not look right. Use http:// and the Umbrel\'s Tailscale IP, for example http://100.101.146.83');
    let token = pasted.trim();
    const bearer = token.match(/Bearer\s+(\S+)/i);
    if (bearer) token = bearer[1];
    token = token.replace(/[.\u2026]+$/, '');
    if (token && !/^[\x21-\x7e]{8,4096}$/.test(token)) throw new HttpError(400, 'Paste the token from the Umbrel\'s Connect your agent screen (it starts with umbrelmcp_).');
    return { url, token };
  }

  function createUmbrel(body) {
    const cfg = umbrelConfig(body);
    if (!cfg.url || !cfg.token) throw new HttpError(400, 'Fill in the address and the token.');
    const name = (String(body.name || '').trim() || cfg.url.replace(/^https?:\/\//, '')).slice(0, 60);
    const machine = newMachine(name, 'umbrel');
    machine.umbrel = cfg;
    store.save();
    checkUmbrel(machine.id).catch(() => {});
    return { machine: { id: machine.id, name, os: 'umbrel' } };
  }

  const umbrelBusy = new Map();
  function onUmbrel(id, fn) {
    const prev = umbrelBusy.get(id) || Promise.resolve();
    const next = prev.then(fn, fn);
    umbrelBusy.set(id, next.catch(() => {}));
    return next;
  }

  function checkUmbrel(id) {
    return onUmbrel(id, async () => {
      const machine = S().machines[id];
      if (!machine || !machine.umbrel) return;
      try {
        const r = await umbrel.check(machine.umbrel);
        machine.items = r.items;
        machine.badges = r.badges;
        machine.lastSeen = iso();
        machine.checkError = '';
        const keys = new Set(r.items.map(itemKey));
        for (const k of Object.keys(machine.lastResults || {})) if (!keys.has(k)) delete machine.lastResults[k];
      } catch (e) {
        // Messages come from the MCP client, which never includes the token.
        machine.checkError = String(e.message || 'check failed').slice(0, 200);
      }
      store.save();
    });
  }

  async function checkAllUmbrels() {
    for (const m of Object.values(S().machines)) if (m.os === 'umbrel') await checkUmbrel(m.id);
  }

  const openJobs = (machineId) => S().jobs.filter((j) => j.machineId === machineId && (j.status === 'queued' || j.status === 'running'));

  function queueUmbrel(machine, body) {
    let targets;
    if (body.id) {
      const it = (machine.items || []).find((x) => itemId(x.channel, x.name) === body.id);
      if (!it) throw new HttpError(404, 'no such update');
      if (!actionable(it, machine)) throw new HttpError(409, 'not updatable');
      targets = [{ channel: it.channel, name: it.name }];
    } else targets = (machine.items || []).filter((it) => actionable(it, machine) && inUpdateAll(it)).map((it) => ({ channel: it.channel, name: it.name }));
    const busy = new Set(openJobs(machine.id).flatMap((j) => j.items.map(itemKey)));
    targets = targets.filter((t) => !busy.has(itemKey(t)));
    if (targets.length) S().jobs.push({ id: newId(5), machineId: machine.id, items: targets, status: 'queued', createdAt: iso() });
    store.save();
    runUmbrelJobs(machine.id).catch(() => {});
    return { ok: true };
  }

  function runUmbrelJobs(id) {
    return onUmbrel(id, async () => {
      const machine = S().machines[id];
      if (!machine) return;
      for (const job of openJobs(id)) {
        job.status = 'running';
        store.save();
        for (const x of [...job.items]) {
          const it = (machine.items || []).find((y) => itemKey(y) === itemKey(x)) || { ...x, title: x.name };
          let r;
          try {
            r = x.channel === 'umbrel-os' ? await umbrel.updateOs(machine.umbrel) : await umbrel.updateApp(machine.umbrel, x.name);
          } catch (e) {
            r = { status: 'failed', message: String(e.message || 'failed').slice(0, 300) };
          }
          log(machine, 'click', { ...it, from: r.from || it.current, to: r.to || it.latest }, r.status, r.message);
          machine.lastResults ||= {};
          if (r.status === 'installed') delete machine.lastResults[itemKey(x)];
          else machine.lastResults[itemKey(x)] = { status: r.status, message: r.message, at: iso() };
          job.items = job.items.filter((y) => itemKey(y) !== itemKey(x));
          store.save();
        }
        job.status = 'done';
        job.doneAt = iso();
        store.save();
      }
      S().jobs = S().jobs.filter((j) => j.status !== 'done' || now() - Date.parse(j.doneAt) < 7 * 24 * 3600 * 1000);
      store.save();
    }).then(() => checkUmbrel(id));
  }

  // Umbrel updates that were running when the server stopped are not started again.
  for (const j of S().jobs) {
    if (j.status === 'running' || j.status === 'queued') {
      j.status = 'done';
      j.doneAt = iso();
    }
  }

  // ---- page ----

  function view(req) {
    const st = S();
    const machines = Object.values(st.machines)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((m) => {
        const approval = m.os === 'umbrel' ? null : approvalView(m);
        const busy = new Set(openJobs(m.id).flatMap((j) => j.items.map(itemKey)));
        const items = (m.items || []).map((it) => {
          const id = itemId(it.channel, it.name);
          return {
            id,
            channel: it.channel,
            name: it.name,
            title: it.title || it.name,
            current: it.current,
            latest: it.latest,
            flags: it.flags || {},
            services: it.services,
            actionable: actionable(it, m),
            inUpdateAll: inUpdateAll(it),
            pinned: it.channel === 'dockge' ? stackPinned(it, m.overrides) : !!(it.flags || {}).pinned,
            override: it.channel === 'dockge' ? (m.overrides || {})[it.name] || null : null,
            askFirst: it.channel === 'winget' && matchesAskFirst(it.name, st.askFirst),
            queued: busy.has(itemKey(it)) || !!(approval && approval.waiting && (!approval.only.length || approval.only.includes(id))),
            result: (m.lastResults || {})[itemKey(it)] || null,
          };
        });
        return {
          id: m.id,
          name: m.name,
          os: m.os,
          host: m.host || '',
          address: m.umbrel ? m.umbrel.url : '',
          createdAt: m.createdAt,
          lastSeen: m.lastSeen || null,
          pending: items.filter((i) => i.actionable).length,
          approval,
          uninstall: uninstallCommand(m.os, baseUrl(req)),
          items,
          needs: needsList(m),
        };
      });
    return { machines, askFirst: st.askFirst, log: st.log.slice(-300).reverse(), signer: { mode: signer.mode, pubkey: signer.pubkey } };
  }

  function setAskFirst(body) {
    const id = String(body.id || '').trim();
    if (!/^[\w.+*-]{1,200}$/.test(id)) throw new HttpError(400, 'id');
    const list = S().askFirst.filter((x) => x.toLowerCase() !== id.toLowerCase());
    if (body.on) list.push(id);
    S().askFirst = list.sort((a, b) => a.localeCompare(b));
    store.save();
    return { askFirst: S().askFirst };
  }

  function setOverride(machine, body) {
    const stack = String(body.stack || '');
    if (!stack) throw new HttpError(400, 'stack');
    machine.overrides ||= {};
    if (body.mode === 'pinned' || body.mode === 'compare') machine.overrides[stack] = body.mode;
    else delete machine.overrides[stack];
    store.save();
    return { ok: true };
  }

  // ---- http ----

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, 'too big'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function jsonBody(req) {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'json only');
    const text = await readBody(req);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new HttpError(400, 'bad json');
    }
  }

  function send(res, status, body, type) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, {
      'content-type': type || (typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json'),
      'content-length': buf.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(buf);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const m = req.method;
    try {
      if (m === 'GET' && STATIC[p]) {
        const [file, type] = STATIC[p];
        return send(res, 200, fs.readFileSync(path.join(here, 'page', file)), type);
      }
      if (m === 'GET' && p === '/healthz') return send(res, 200, 'ok\n');

      // Outside the Umbrel login: install scripts (a join token gets a machine in), agent files,
      // and the agent API, where every report is checked against the machine's own key.
      let a;
      if ((a = /^\/install\/(mac|linux|windows)(\/uninstall)?$/.exec(p)) && m === 'GET') {
        if (a[2]) return send(res, 200, fs.readFileSync(path.join(agentsDir, a[1], a[1] === 'windows' ? 'uninstall.ps1' : 'uninstall.sh')), 'text/plain; charset=utf-8');
        return send(res, 200, installScript(a[1], baseUrl(req), url.searchParams.get('t') || ''), 'text/plain; charset=utf-8');
      }
      if ((a = /^\/api\/agent\/files\/([a-z]+)\/([\w.-]+)$/.exec(p)) && m === 'GET') {
        if (!(AGENT_FILES[a[1]] || []).includes(a[2])) throw new HttpError(404, 'no such file');
        return send(res, 200, fs.readFileSync(path.join(agentsDir, a[1], a[2])), 'text/plain; charset=utf-8');
      }
      if ((a = /^\/api\/agent\/bin\/([\w.-]+?)(\.sha256)?$/.exec(p)) && m === 'GET') {
        if (!BINARIES.includes(a[1])) throw new HttpError(404, 'no such binary');
        const file = path.join(distDir, a[1]);
        if (!fs.existsSync(file)) throw new HttpError(404, 'not built');
        const data = fs.readFileSync(file);
        if (a[2]) return send(res, 200, `${crypto.createHash('sha256').update(data).digest('hex')}  ${a[1]}\n`);
        return send(res, 200, data, 'application/octet-stream');
      }
      if (p === '/api/agent/register' && m === 'POST') return send(res, 200, register(await jsonBody(req)));
      if (p === '/api/agent/report' && m === 'POST') return send(res, 200, report(await jsonBody(req)));
      if (p === '/api/agent/approval' && m === 'GET') {
        const machine = S().machines[url.searchParams.get('m') || ''];
        return send(res, 200, { approval: machine ? machine.approval || null : null });
      }
      if (p.startsWith('/api/agent/')) throw new HttpError(404, 'not found');

      // The page. Behind the Umbrel login.
      if (p === '/api/state' && m === 'GET') return send(res, 200, view(req));
      if (p === '/api/joins' && m === 'POST') return send(res, 200, createJoin(await jsonBody(req), req));
      if (p === '/api/umbrels' && m === 'POST') return send(res, 200, createUmbrel(await jsonBody(req)));
      if (p === '/api/ask-first' && m === 'POST') return send(res, 200, setAskFirst(await jsonBody(req)));
      if (p === '/api/dev/sign' && m === 'POST') {
        if (!signer.sign) throw new HttpError(404, 'no dev signer');
        const body = await jsonBody(req);
        const t = body.event || {};
        // Only approvals, only as the page built them.
        if (!t.tags || !Array.isArray(t.tags) || t.kind !== approvalTemplate({ machineId: '', reportHash: '', counter: 0, now: 0 }).kind) throw new HttpError(400, 'approvals only');
        return send(res, 200, { event: signer.sign({ kind: t.kind, created_at: Math.min(Number(t.created_at) || nowS(), nowS()), tags: t.tags, content: '' }) });
      }
      if ((a = /^\/api\/machines\/([0-9a-f]+)(?:\/(draft|approval|update|override|umbrel|check))?$/.exec(p))) {
        const machine = machineById(a[1]);
        if (!a[2] && m === 'DELETE') {
          removeMachine(machine);
          return send(res, 200, { ok: true });
        }
        if (a[2] === 'draft' && m === 'POST') return send(res, 200, { event: draft(machine, await jsonBody(req)) });
        if (a[2] === 'approval' && m === 'POST') return send(res, 200, storeApproval(machine, (await jsonBody(req)).event));
        if (a[2] === 'update' && m === 'POST') {
          if (machine.os !== 'umbrel') throw new HttpError(409, 'machines update by approval');
          return send(res, 200, queueUmbrel(machine, await jsonBody(req)));
        }
        if (a[2] === 'override' && m === 'POST') return send(res, 200, setOverride(machine, await jsonBody(req)));
        if (a[2] === 'umbrel' && m === 'POST') {
          if (machine.os !== 'umbrel') throw new HttpError(409, 'not an Umbrel');
          const cfg = umbrelConfig(await jsonBody(req));
          machine.umbrel = { url: cfg.url || machine.umbrel.url, token: cfg.token || machine.umbrel.token };
          store.save();
          await checkUmbrel(machine.id);
          return send(res, 200, { ok: true });
        }
        if (a[2] === 'check' && m === 'POST') {
          await jsonBody(req);
          if (machine.os === 'umbrel') await checkUmbrel(machine.id);
          return send(res, 200, { ok: true });
        }
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: 'server error' });
    }
  }

  return { handle, store, signer, checkUmbrel, checkAllUmbrels, idle: () => Promise.all([...umbrelBusy.values()]) };
}

export { tag };
