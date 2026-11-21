// Reference parsers for the package managers' output. The agent (agent/parse.go) carries the same
// rules; test/parsers.test.js holds the two equal on the shared fixtures. The server itself gets
// parsed items from the agents' signed reports and does not call these.
//
// Envelope:
//   #fleet os mac
//   #fleet host Aarons-Mac
//   #fleet section brew-outdated
//   <raw output>
//   #fleet section softwareupdate
//   <raw output>

export function parseEnvelope(text) {
  const meta = {};
  const sections = {};
  let current = null;
  for (const line of String(text).split('\n')) {
    const m = /^#fleet (\S+)(?: (.*))?$/.exec(line.replace(/\r$/, ''));
    if (m) {
      if (m[1] === 'section') {
        current = (m[2] || '').trim();
        sections[current] = [];
      } else {
        meta[m[1]] = (m[2] || '').trim();
        current = null;
      }
      continue;
    }
    if (current !== null) sections[current].push(line);
  }
  const out = {};
  for (const [k, v] of Object.entries(sections)) out[k] = v.join('\n');
  return { meta, sections: out };
}

function safeJson(text) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    // brew can print warnings before the JSON.
    const i = text.indexOf('{');
    if (i > 0) {
      try {
        return JSON.parse(text.slice(i));
      } catch {}
    }
    return null;
  }
}

// ---- Mac ----

// `brew outdated --json=v2`
export function parseBrewOutdated(text) {
  const j = safeJson(text);
  if (!j) return [];
  const items = [];
  for (const f of j.formulae || []) {
    items.push({
      channel: 'brew-formula',
      name: f.name,
      title: f.name,
      current: (f.installed_versions || []).at(-1) || '',
      latest: f.current_version || '',
      flags: f.pinned ? { pinned: true } : {},
    });
  }
  for (const c of j.casks || []) {
    items.push({
      channel: 'brew-cask',
      name: c.name,
      title: c.name,
      current: (c.installed_versions || []).at(-1) || '',
      latest: c.current_version || '',
      flags: {},
    });
  }
  return items;
}

// `brew info --cask --json=v2 --installed`: which casks are .pkg installers and which apps they own.
export function parseBrewCasks(text) {
  const j = safeJson(text);
  const map = {};
  if (!j) return map;
  for (const c of j.casks || []) {
    const apps = [];
    let pkg = false;
    for (const a of c.artifacts || []) {
      if (!a || typeof a !== 'object') continue;
      if (a.pkg || a.installer) pkg = true;
      for (const app of a.app || []) {
        const name = typeof app === 'string' ? app : null;
        if (name) apps.push(name.split('/').pop());
      }
    }
    map[c.token] = { title: (c.name || [])[0] || c.token, pkg, apps };
  }
  return map;
}

// `softwareupdate -l`
export function parseSoftwareUpdate(text) {
  const badges = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*Title:\s*(.+?),\s*Version:\s*([^,]+)(.*)$/.exec(line);
    if (!m) continue;
    const restart = /Action:\s*restart/i.test(m[3]);
    badges.push({ channel: 'softwareupdate', title: m[1].trim(), version: m[2].trim(), restart });
  }
  return badges;
}

// `ps -axo comm=`: the app bundles that are running.
export function parseRunningApps(text) {
  const set = new Set();
  for (const line of String(text || '').split('\n')) {
    const m = /([^/]+\.app)\/Contents\//.exec(line);
    if (m) set.add(m[1]);
  }
  return set;
}

// ---- Windows ----

// `winget upgrade` table. Columns are found from the right (Source, Available, Version, Id), so
// wide characters in names do not shift them.
export function parseWinget(text) {
  const items = [];
  let explicit = false;
  let inTable = false;
  let hasSource = true;
  for (let raw of String(text || '').split('\n')) {
    raw = raw.replace(/\r$/, '');
    const line = raw.includes('\r') ? raw.slice(raw.lastIndexOf('\r') + 1) : raw;
    if (/require explicit targeting/i.test(line)) {
      explicit = true;
      inTable = false;
      continue;
    }
    if (/^\s*Name\s+Id\s+Version\s+Available/.test(line)) {
      hasSource = /\sSource\s*$/.test(line);
      continue;
    }
    if (/^-{10,}\s*$/.test(line.trim())) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.trim() || /^\d+ (upgrades?|packages?)/i.test(line.trim()) || /cannot be determined/i.test(line)) {
      inTable = false;
      continue;
    }
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < (hasSource ? 5 : 4)) continue;
    let source = '';
    if (hasSource) source = tokens.pop();
    const latest = tokens.pop();
    let current = tokens.pop();
    if (tokens.length && /^[<>]$/.test(tokens.at(-1))) current = tokens.pop() + ' ' + current;
    const id = tokens.pop();
    const title = tokens.join(' ').replace(/…$/, '').trim() || id;
    if (!id || !/^[\w.+-]+$/.test(id)) continue;
    const flags = {};
    if (explicit) flags.explicit = true;
    items.push({ channel: 'winget', name: id, title, current, latest, source, flags });
  }
  return items;
}

// Agent-made section: one Windows Update title per line.
export function parseWindowsUpdate(text, rebootPending) {
  const titles = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const badges = [];
  if (titles.length) badges.push({ channel: 'windows-update', title: 'Windows Update', count: titles.length, titles });
  if (String(rebootPending || '').trim() === '1') badges.push({ channel: 'windows-update', title: 'Reboot pending', reboot: true });
  return badges;
}

// ---- Linux ----

function flatpakRows(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const cols = line.includes('\t') ? line.split('\t') : line.trim().split(/\s{2,}/);
    if (/^Application( ID)?$/i.test(cols[0].trim())) continue;
    rows.push(cols.map((c) => c.trim()));
  }
  return rows;
}

// `flatpak remote-ls --updates --columns=application,branch,version` and
// `flatpak list --columns=application,branch,version`
export function parseFlatpak(updatesText, listText, scope) {
  const installed = {};
  for (const [app, branch, version] of flatpakRows(listText)) installed[`${app}//${branch || ''}`] = version || '';
  const items = [];
  for (const [app, branch, version] of flatpakRows(updatesText)) {
    if (!app) continue;
    const name = branch ? `${app}//${branch}` : app;
    items.push({
      channel: `flatpak-${scope}`,
      name,
      title: app,
      current: installed[`${app}//${branch || ''}`] || '',
      latest: version || '',
      flags: {},
    });
  }
  return items;
}

// `rpm-ostree status --json`: badge only.
export function parseRpmOstree(text) {
  const j = safeJson(text);
  if (!j) return [];
  const badges = [];
  const staged = (j.deployments || []).find((d) => d.staged && !d.booted);
  if (staged) badges.push({ channel: 'rpm-ostree', title: `System update ${staged.version || ''}`.trim(), restart: true, staged: true });
  const cached = j['cached-update'];
  if (cached && (!staged || cached.version !== staged.version))
    badges.push({ channel: 'rpm-ostree', title: `System update ${cached.version || ''}`.trim(), restart: true });
  return badges;
}

// ---- Dockge ----

// An image is pinned when it is referenced by digest or by an exact version tag (2.5, 0.12.12,
// 2026.7.2, v1.104.1) or a commit tag (sha-fc4319c). A major-only tag (postgres:17) is
// pinned-major: compared with the registry, so updates within 17 are offered, and the tag itself
// is never changed. Everything else (latest, 2-alpine, 12-slim) is floating and compared.
export function imageTag(ref) {
  const at = ref.indexOf('@');
  const base = at >= 0 ? ref.slice(0, at) : ref;
  const slash = base.lastIndexOf('/');
  const colon = base.lastIndexOf(':');
  return colon > slash ? base.slice(colon + 1) : 'latest';
}

export function majorOf(ref) {
  if (ref.includes('@')) return null;
  const m = /^v?(\d+)$/.exec(imageTag(ref));
  return m ? m[1] : null;
}

export function isPinnedRef(ref) {
  if (/@sha256:[0-9a-f]+/i.test(ref)) return true;
  const tag = imageTag(ref);
  if (/(^|[^0-9.])v?\d+\.\d+/.test(tag)) return true;
  if (/^(sha-)?[0-9a-f]{7,40}$/i.test(tag) && /[a-f]/i.test(tag) && /\d/.test(tag)) return true;
  return false;
}

function digestOf(s) {
  const m = /sha256:[0-9a-f]{64}/i.exec(s || '');
  return m ? m[0].toLowerCase() : null;
}

function shortDigest(d) {
  return d ? d.replace(/^sha256:/, '').slice(0, 12) : '';
}

// services: lines `stack \t service \t image ref \t image id \t state \t repo digests (comma) or -`
// registry: lines `image ref \t sha256:... ` or `image ref \t error \t message`
export function parseDockge(servicesText, registryText) {
  const registry = {};
  for (const line of String(registryText || '').split('\n')) {
    const [ref, d, msg] = line.split('\t');
    if (!ref || !ref.trim()) continue;
    registry[ref.trim()] = digestOf(d) ? { digest: digestOf(d) } : { error: (msg || d || 'error').trim() };
  }
  const stacks = new Map();
  for (const line of String(servicesText || '').split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 2 || !cols[0].trim()) continue;
    const [stack, service, ref, imageId, state, repoDigests] = cols.map((c) => (c || '').trim());
    if (!stacks.has(stack)) stacks.set(stack, []);
    if (service && service !== '-') {
      const digests = (repoDigests && repoDigests !== '-' ? repoDigests.split(',') : []).map(digestOf).filter(Boolean);
      stacks.get(stack).push({ service, ref, imageId, state, digests });
    }
  }
  const items = [];
  for (const [stack, services] of stacks) {
    const flags = {};
    let current = '';
    let latest = '';
    if (!services.length) flags.notRunning = true;
    for (const s of services) {
      s.pinned = isPinnedRef(s.ref);
      s.major = s.pinned ? null : majorOf(s.ref);
      s.local = s.digests.length === 0;
      if (s.pinned) flags.pinnedRef = true;
      if (s.major) (flags.majors ||= []).includes(s.major) || flags.majors.push(s.major);
      if (s.local) {
        flags.local = true;
        continue;
      }
      const r = registry[s.ref];
      if (!r) continue;
      if (r.error) {
        s.checkFailed = r.error;
        flags.checkFailed = true;
        continue;
      }
      s.latest = r.digest;
      s.update = !s.digests.includes(r.digest);
      if (s.update) {
        flags.update = true;
        if (!current) {
          current = shortDigest(s.digests[0]);
          latest = shortDigest(r.digest);
        }
      }
    }
    if (services.length && services.every((s) => s.state && s.state !== 'running')) flags.notRunning = true;
    items.push({
      channel: 'dockge',
      name: stack,
      title: stack,
      current,
      latest,
      flags,
      services: services.map((s) => ({ service: s.service, ref: s.ref, pinned: s.pinned, major: s.major, local: s.local, update: !!s.update, checkFailed: s.checkFailed || null })),
    });
  }
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return items;
}

// ---- Whole report ----

export function parseReport(text) {
  const { meta, sections: s } = parseEnvelope(text);
  const os = meta.os || '';
  let items = [];
  let badges = [];
  if ('brew-outdated' in s) {
    const casks = parseBrewCasks(s['brew-casks']);
    const running = parseRunningApps(s.running);
    for (const it of parseBrewOutdated(s['brew-outdated'])) {
      if (it.channel === 'brew-cask') {
        const info = casks[it.name];
        if (info) {
          it.title = info.title;
          if (info.pkg) it.flags.pkg = true;
          if (info.apps.length) it.flags.apps = info.apps;
          if (info.apps.some((a) => running.has(a))) it.flags.running = true;
        }
      }
      items.push(it);
    }
  }
  if ('softwareupdate' in s) badges.push(...parseSoftwareUpdate(s.softwareupdate));
  if ('winget' in s) items.push(...parseWinget(s.winget));
  if ('windows-update' in s || 'reboot-pending' in s) badges.push(...parseWindowsUpdate(s['windows-update'], s['reboot-pending']));
  for (const scope of ['user', 'system']) {
    if (`flatpak-${scope}-updates` in s) items.push(...parseFlatpak(s[`flatpak-${scope}-updates`], s[`flatpak-${scope}-list`], scope));
  }
  if ('rpm-ostree' in s) badges.push(...parseRpmOstree(s['rpm-ostree']));
  if ('docker-services' in s) items.push(...parseDockge(s['docker-services'], s['docker-registry']));
  return { os, host: meta.host || '', agent: meta.agent || '', items, badges };
}
