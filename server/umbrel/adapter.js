// Umbrel apps and umbrelOS through each Umbrel's MCP endpoint. Click-only: nothing here runs
// overnight.
//
// FIELD ASSUMPTIONS, all in this block. Recorded from xumbrel's MCP tools on 2026-11-21
// (test/fixtures/umbrel); the update calls could not be recorded without updating something.
export const TOOLS = {
  listApps: 'list_apps', // -> [{ id, name, version, state, progress, updateAvailable }] (seen)
  appStatus: 'get_app_status', // (appId) -> { appId, state, progress, activeOperation, lastOperationFailure } (seen, both null)
  appDetails: 'get_app_details', // (appId) -> { id, version, settings.storage.serviceImages{svc: ref} } (seen)
  updateApp: 'update_app', // (appId) -> anything; ASSUMED to return once the update has started
  checkOs: 'check_os_update', // -> { available, version, name, releaseNotes } (seen)
  installOs: 'install_os_update', // () -> anything; ASSUMED to start the update and reboot later
  osStatus: 'get_os_update_status', // -> { running, progress, description, error } (seen)
};
export const F = {
  appsList: (r) => (Array.isArray(r) ? r : r?.apps || []),
  appId: (a) => a.id,
  appName: (a) => a.name || a.id,
  appVersion: (a) => a.version || '',
  appUpdate: (a) => a.updateAvailable === true,
  appState: (a) => a.state || '',
  // ASSUMED: the target version is not in list_apps; the page shows "update" without it.
  appLatest: (a) => a.latestVersion || a.availableVersion || '',
  statusBusy: (s) => s?.activeOperation != null,
  // ASSUMED shape for a failure: a string, or an object with message/error.
  statusFailure: (s) => {
    const f = s?.lastOperationFailure;
    if (!f) return '';
    if (typeof f === 'string') return f;
    return String(f.message || f.error || f.reason || JSON.stringify(f)).slice(0, 300);
  },
  detailsVersion: (d) => d?.version || '',
  detailsImages: (d) => {
    const imgs = d?.settings?.storage?.serviceImages || d?.settings?.environment?.serviceImages || {};
    return Object.values(imgs).sort().join(' ');
  },
  osAvailable: (o) => o?.available === true,
  osVersion: (o) => o?.version || '',
  osName: (o) => o?.name || `umbrelOS ${o?.version || ''}`.trim(),
};
// Apps whose store can lag behind (an update may reinstall the old version): always status-checked.
export const WATCH_APPS = [/^keykin-/];
// ---- end of assumptions ----

import { openSession } from './mcp.js';

export function createUmbrelAdapter({ fetch: f = fetch, pollMs = 5000, maxWaitMs = 15 * 60 * 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const session = (cfg) => openSession(cfg.url.replace(/\/+$/, '') + '/mcp', cfg.token, { fetch: f });

  // -> { items, badges }
  async function check(cfg) {
    const s = await session(cfg);
    const apps = F.appsList(await s.call(TOOLS.listApps));
    const items = [];
    for (const a of apps) {
      const id = F.appId(a);
      const watch = WATCH_APPS.some((re) => re.test(id));
      const busyState = !['ready', 'running', 'stopped'].includes(F.appState(a));
      if (!F.appUpdate(a) && !watch && !busyState) continue;
      const st = await s.call(TOOLS.appStatus, { appId: id });
      const failure = F.statusFailure(st);
      if (!F.appUpdate(a) && !failure) continue;
      const flags = {};
      if (failure) flags.failure = failure;
      if (F.statusBusy(st)) flags.busy = true;
      if (!F.appUpdate(a)) flags.noUpdate = true;
      items.push({ channel: 'umbrel-app', name: id, title: F.appName(a), current: F.appVersion(a), latest: F.appLatest(a), flags });
    }
    const os = await s.call(TOOLS.checkOs);
    if (F.osAvailable(os)) items.push({ channel: 'umbrel-os', name: 'umbrelos', title: F.osName(os), current: '', latest: F.osVersion(os), flags: { reboot: true } });
    return { items, badges: [] };
  }

  // -> { status, message, from, to }
  async function updateApp(cfg, appId) {
    const s = await session(cfg);
    const before = await s.call(TOOLS.appDetails, { appId });
    await s.call(TOOLS.updateApp, { appId });
    const started = Date.now();
    let st = null;
    do {
      await sleep(pollMs);
      st = await s.call(TOOLS.appStatus, { appId });
    } while ((F.statusBusy(st) || F.appState(st) === 'updating') && Date.now() - started < maxWaitMs);
    const failure = F.statusFailure(st);
    if (failure) return { status: 'failed', message: failure, from: F.detailsVersion(before) };
    if (F.statusBusy(st)) return { status: 'failed', message: 'still updating after 15 minutes', from: F.detailsVersion(before) };
    const after = await s.call(TOOLS.appDetails, { appId });
    const same = F.detailsVersion(after) === F.detailsVersion(before) && F.detailsImages(after) === F.detailsImages(before);
    if (same) return { status: 'still-old', message: 'still old, retry in a few minutes', from: F.detailsVersion(before), to: F.detailsVersion(after) };
    return { status: 'installed', message: '', from: F.detailsVersion(before), to: F.detailsVersion(after) };
  }

  async function updateOs(cfg) {
    const s = await session(cfg);
    const os = await s.call(TOOLS.checkOs);
    await s.call(TOOLS.installOs);
    const st = await s.call(TOOLS.osStatus);
    if (st && st.error) return { status: 'failed', message: String(st.description || 'update failed').slice(0, 300) };
    return { status: 'started', message: 'reboots when done', to: F.osVersion(os) };
  }

  return { check, updateApp, updateOs };
}
