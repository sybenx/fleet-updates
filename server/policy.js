// What may install overnight, what a click installs, and what needs Aaron.

export const DEFAULT_ASK_FIRST = [
  // Java runtimes: the Minecraft servers on Took run on Java.
  'EclipseAdoptium.*',
  'Oracle.JDK.*',
  'Oracle.JavaRuntimeEnvironment',
  'Microsoft.OpenJDK.*',
];

export function matchesAskFirst(id, list) {
  const lower = id.toLowerCase();
  return list.some((p) => {
    const q = p.toLowerCase();
    return q.endsWith('*') ? lower.startsWith(q.slice(0, -1)) : lower === q;
  });
}

export function itemKey(it) {
  return `${it.channel}\u0000${it.name}`;
}

export function caskSeenKey(it) {
  return `${it.name}@${it.latest}`;
}

// Dockge stacks: an override on the page beats what the image refs say.
export function stackPinned(item, overrides = {}) {
  const o = overrides[item.name];
  if (o === 'pinned') return true;
  if (o === 'compare') return false;
  return !!item.flags.pinnedRef;
}

// umbrelOS restarts the Umbrel: it has its own button and is never part of Update all.
export function inUpdateAll(item) {
  return item.channel !== 'umbrel-os';
}

// Can a click install it?
export function actionable(item, machine) {
  if (item.channel === 'dockge') {
    const f = item.flags;
    return !!f.update && !f.local && !f.notRunning && !stackPinned(item, machine.overrides);
  }
  if (item.channel === 'brew-formula' && item.flags.pinned) return false;
  if (item.channel === 'umbrel-app' && (item.flags.noUpdate || item.flags.busy)) return false;
  return true;
}

// May it install between 02:00 and 05:00 without asking? The agent adds its own local checks
// (time window, app not running, no game running).
export function overnightEligible(item, { askFirst, caskSeen, now, caskAgeHours }) {
  switch (item.channel) {
    case 'flatpak-user':
    case 'flatpak-system':
      return true;
    case 'brew-formula':
      return !item.flags.pinned;
    case 'brew-cask': {
      if (item.flags.pkg) return false;
      const seen = caskSeen[caskSeenKey(item)];
      if (!seen) return false;
      return now - Date.parse(seen) >= caskAgeHours * 3600 * 1000;
    }
    case 'winget':
      return !item.flags.explicit && !matchesAskFirst(item.name, askFirst);
    default:
      return false;
  }
}

function systemBadgeText(b) {
  if (b.channel === 'softwareupdate') return b.restart ? `${b.title}, reboot after` : b.title;
  if (b.channel === 'rpm-ostree') return b.staged ? `Reboot to finish ${b.title}` : `${b.title}, reboot after`;
  if (b.channel === 'windows-update') return b.reboot ? 'Reboot to finish updates' : `Windows Update: ${b.count}`;
  return b.title;
}

// The short list under each card.
export function needsList(machine) {
  const needs = [];
  const results = machine.lastResults || {};
  let waitingForGame = 0;
  for (const it of machine.items || []) {
    const r = results[itemKey(it)];
    if (it.channel === 'brew-cask' && it.flags.pkg) needs.push({ text: `${it.title} needs your password`, key: itemKey(it) });
    else if (r && r.status === 'needs-password') needs.push({ text: `${it.title} needs your password`, key: itemKey(it) });
    else if ((it.flags.running && it.channel === 'brew-cask') || (r && r.status === 'quit-first')) needs.push({ text: `Quit ${it.title} first`, key: itemKey(it) });
    else if (r && r.status === 'failed') needs.push({ text: `${it.title} failed`, detail: r.message, key: itemKey(it) });
    if (r && r.status === 'game-running') waitingForGame++;
    if (it.flags.failure) needs.push({ text: `${it.title}: ${it.flags.failure}`, key: itemKey(it) });
    if (r && r.status === 'still-old') needs.push({ text: `${it.title} still old, retry in a few minutes`, key: itemKey(it) });
    if (it.channel === 'umbrel-os') needs.push({ text: `${it.title}, restarts the Umbrel`, key: itemKey(it) });
  }
  if (waitingForGame) needs.push({ text: `After the game closes: ${waitingForGame}` });
  for (const b of machine.badges || []) needs.push({ text: systemBadgeText(b) });
  if (machine.checkError) needs.unshift({ text: `Not reachable: ${machine.checkError}` });
  return needs;
}
